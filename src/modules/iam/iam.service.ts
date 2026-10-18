import type { PrismaClient, Role as PrismaRole, User } from '@prisma/client';
import type { Env } from '../../config/env';
import { signJwt, verifyJwt } from '../../core/crypto/jwt';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { AuditService } from '../audit/audit.service';
import { hashPassword, verifyPasswordTimingSafe } from './passwords';
import type { SessionService } from './sessions';
import { generateTotpSecret, totpKeyUri, verifyTotpCode } from './totp';
import type { Role } from '../../core/http/auth';

export interface IssuedTokens {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface CreateUserInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  student?: {
    studentNo: string;
    programId: string;
    curriculumVersionId: string;
    yearLevel?: number;
  };
}

export class IamService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sessions: SessionService | null,
    private readonly audit: AuditService,
    private readonly config: Env,
  ) {}

  // ── Token helpers ──────────────────────────────────────────────────────────

  private requireSessions(): SessionService {
    if (!this.sessions) {
      throw new AppError(ErrorCodes.REFRESH_TOKEN_INVALID, 'Session store (Redis) is unavailable — refresh grant disabled.');
    }
    return this.sessions;
  }

  private signAccessToken(user: Pick<User, 'id' | 'roles'>, familyId: string | null, mfa = false, mfaAt?: number): string {
    return signJwt(
      {
        sub: user.id,
        typ: 'access',
        sid: familyId ?? undefined,
        roles: user.roles as string[],
        mfa,
        ...(mfaAt !== undefined ? { mfaAt } : {}),
      },
      this.config.jwtAccessSecret,
      this.config.accessTokenTtlMinutes * 60,
      new Date(),
    );
  }

  private async issueTokens(user: Pick<User, 'id' | 'roles'>): Promise<IssuedTokens> {
    const { refreshToken, familyId } = await this.requireSessions().issue(user.id);
    return {
      tokenType: 'Bearer',
      accessToken: this.signAccessToken(user, familyId),
      refreshToken,
      expiresInSeconds: this.config.accessTokenTtlMinutes * 60,
    };
  }

  // ── User administration ────────────────────────────────────────────────────

  async createUser(
    actorId: string,
    input: CreateUserInput,
  ): Promise<Omit<User, 'passwordHash' | 'totpSecret'> & { studentNo: string | null }> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new AppError(ErrorCodes.CONFLICT, `A user with email ${email} already exists.`);

    const isStudent = input.roles.includes('STUDENT');
    if (isStudent && !input.student) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'STUDENT role requires the student profile block (studentNo, programId, curriculumVersionId).');
    }
    if (!isStudent && input.student) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'student profile can only be attached to STUDENT role users.');
    }

    const passwordHash = await hashPassword(input.password);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          roles: input.roles as PrismaRole[],
        },
      });

      if (input.student) {
        const program = await tx.program.findUnique({ where: { id: input.student.programId } });
        if (!program) throw new AppError(ErrorCodes.NOT_FOUND, 'Program not found.');
        const curriculum = await tx.curriculumVersion.findUnique({ where: { id: input.student.curriculumVersionId } });
        if (!curriculum || curriculum.programId !== input.student.programId) {
          throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Curriculum version does not belong to the given program.');
        }
        await tx.studentProfile.create({
          data: {
            userId: created.id,
            studentNo: input.student.studentNo,
            programId: input.student.programId,
            curriculumVersionId: input.student.curriculumVersionId,
            yearLevel: input.student.yearLevel ?? 1,
          },
        });
      }

      await this.audit.append(tx, {
        actorId,
        action: 'iam.user.created',
        resourceType: 'user',
        resourceId: created.id,
        payload: { email, roles: input.roles, studentNo: input.student?.studentNo ?? null },
      });

      return created;
    });

    const { passwordHash: _ph, totpSecret: _ts, ...safe } = user;
    return { ...safe, studentNo: input.student?.studentNo ?? null };
  }

  async listUsers(params: { role?: Role; search?: string; limit: number }): Promise<Array<Omit<User, 'passwordHash' | 'totpSecret'> & { studentNo: string | null }>> {
    const users = await this.prisma.user.findMany({
      where: {
        ...(params.role ? { roles: { has: params.role as PrismaRole } } : {}),
        ...(params.search
          ? {
              OR: [
                { email: { contains: params.search, mode: 'insensitive' } },
                { firstName: { contains: params.search, mode: 'insensitive' } },
                { lastName: { contains: params.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { profile: { select: { studentNo: true } } },
      take: params.limit,
      orderBy: { createdAt: 'desc' },
    });
    return users.map(({ passwordHash: _p, totpSecret: _t, profile, ...user }) => ({
      ...user,
      studentNo: profile?.studentNo ?? null,
    }));
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  async login(email: string, password: string): Promise<IssuedTokens | { mfaRequired: true; mfaToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });

    if (!(await verifyPasswordTimingSafe(user?.passwordHash ?? null, password)) || !user) {
      await this.audit.appendStandalone({
        actorId: user?.id ?? null,
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: user?.id ?? null,
        payload: { email: email.trim().toLowerCase() },
      });
      throw new AppError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Invalid email or password.');
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError(ErrorCodes.AUTH_ACCOUNT_DISABLED, `Account is ${user.status.toLowerCase()}.`);
    }

    if (user.totpEnabledAt) {
      if (!this.sessions) {
        throw new AppError(ErrorCodes.AUTH_MFA_REQUIRED, 'Account requires MFA but the session store is unavailable.');
      }
      const mfaToken = signJwt(
        { sub: user.id, typ: 'mfa', roles: user.roles as string[] },
        this.config.jwtMfaSecret,
        this.config.mfaTokenTtlMinutes * 60,
        new Date(),
      );
      return { mfaRequired: true, mfaToken };
    }

    const tokens = await this.issueTokens(user);
    await this.audit.appendStandalone({
      actorId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      payload: { method: 'password' },
    });
    return tokens;
  }

  async completeMfaLogin(mfaToken: string, code: string): Promise<IssuedTokens> {
    const payload = verifyJwt(mfaToken, this.config.jwtMfaSecret, new Date());
    if (payload.typ !== 'mfa') throw new AppError(ErrorCodes.TOKEN_INVALID, 'Expected an MFA challenge token.');

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 'ACTIVE' || !user.totpEnabledAt || !user.totpSecret) {
      throw new AppError(ErrorCodes.AUTH_MFA_INVALID, 'MFA challenge is no longer valid.');
    }
    if (!verifyTotpCode(code, user.totpSecret)) {
      await this.audit.appendStandalone({
        actorId: user.id,
        action: 'auth.mfa_failed',
        resourceType: 'user',
        resourceId: user.id,
        payload: {},
      });
      throw new AppError(ErrorCodes.AUTH_MFA_INVALID, 'Invalid one-time code.');
    }

    const tokens = await this.issueTokens(user);
    await this.audit.appendStandalone({
      actorId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
      payload: { method: 'password+totp' },
    });
    return tokens;
  }

  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const sessions = this.requireSessions();
    const rotation = await sessions.rotate(refreshToken);

    const user = await this.prisma.user.findUnique({ where: { id: rotation.userId } });
    if (!user || user.status !== 'ACTIVE') {
      await sessions.revokeFamily(rotation.familyId);
      throw new AppError(ErrorCodes.AUTH_ACCOUNT_DISABLED, 'Account is not active.');
    }
    return {
      tokenType: 'Bearer',
      accessToken: this.signAccessToken(user, rotation.familyId),
      refreshToken: rotation.refreshToken,
      expiresInSeconds: this.config.accessTokenTtlMinutes * 60,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const sessions = this.requireSessions();
    const familyId = await sessions.revokeByToken(refreshToken);
    if (familyId) {
      await this.audit.appendStandalone({
        actorId: null,
        action: 'auth.logout',
        resourceType: 'session',
        resourceId: familyId,
        payload: {},
      });
    }
  }

  async logoutAll(userId: string): Promise<number> {
    const sessions = this.requireSessions();
    const count = await sessions.revokeAllForUser(userId);
    await this.audit.appendStandalone({
      actorId: userId,
      action: 'auth.logout_all',
      resourceType: 'user',
      resourceId: userId,
      payload: { revokedFamilies: count },
    });
    return count;
  }

  // ── TOTP enrollment & step-up ──────────────────────────────────────────────

  async beginTotpSetup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, 'User not found.');
    if (user.totpEnabledAt) throw new AppError(ErrorCodes.AUTH_MFA_ALREADY_ENABLED, 'MFA is already enabled.');

    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: secret } });
    return { secret, otpauthUrl: totpKeyUri(user.email, 'SchoolLedger', secret) };
  }

  async enableTotp(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret) throw new AppError(ErrorCodes.AUTH_MFA_NOT_SETUP, 'Start TOTP setup first.');
    if (user.totpEnabledAt) throw new AppError(ErrorCodes.AUTH_MFA_ALREADY_ENABLED, 'MFA is already enabled.');
    if (!verifyTotpCode(code, user.totpSecret)) throw new AppError(ErrorCodes.AUTH_MFA_INVALID, 'Invalid one-time code.');

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } });
      await this.audit.append(tx, {
        actorId: userId,
        action: 'iam.totp_enabled',
        resourceType: 'user',
        resourceId: userId,
        payload: {},
      });
    });
  }

  /**
   * Step-up MFA (BSL-005): verifies a fresh TOTP code and mints an access
   * token carrying the `mfa` elevation claim for stepUpTtlMinutes.
   */
  async stepUp(userId: string, code: string, sessionId: string | null): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpEnabledAt || !user.totpSecret) {
      throw new AppError(ErrorCodes.STEP_UP_MFA_NOT_ENROLLED, 'Enroll in TOTP MFA before performing step-up actions.');
    }
    if (!verifyTotpCode(code, user.totpSecret)) {
      await this.audit.appendStandalone({
        actorId: userId,
        action: 'auth.step_up_failed',
        resourceType: 'user',
        resourceId: userId,
        payload: {},
      });
      throw new AppError(ErrorCodes.AUTH_MFA_INVALID, 'Invalid one-time code.');
    }

    const mfaAt = Math.floor(Date.now() / 1000);
    const accessToken = this.signAccessToken(user, sessionId, true, mfaAt);
    await this.audit.appendStandalone({
      actorId: userId,
      action: 'auth.step_up',
      resourceType: 'user',
      resourceId: userId,
      payload: { sessionId },
    });
    return {
      tokenType: 'Bearer',
      accessToken,
      refreshToken: '',
      expiresInSeconds: this.config.accessTokenTtlMinutes * 60,
    };
  }

  // ── Profile ────────────────────────────────────────────────────────────────

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: {
          include: {
            program: { select: { id: true, code: true, name: true, degreeTitle: true } },
            curriculumVersion: { select: { id: true, version: true, name: true, unitsRequired: true, status: true } },
          },
        },
      },
    });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, 'User not found.');
    const { passwordHash: _p, totpSecret: _t, ...safe } = user;
    return { ...safe, mfaEnabled: Boolean(user.totpEnabledAt) };
  }

  async getUserOrThrow(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(ErrorCodes.NOT_FOUND, 'User not found.');
    return user;
  }
}
