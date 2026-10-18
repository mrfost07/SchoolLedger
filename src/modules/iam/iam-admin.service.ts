import { randomBytes } from 'node:crypto';
import type { Invitation, MembershipStatus, PrismaClient, Role as PrismaRole, SchoolMode } from '@prisma/client';
import { sha256Hex } from '../../core/crypto/hash';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { Role } from '../../core/http/auth';
import { requireTenantSchoolId, runWithSystem, runWithTenant } from '../../core/tenant/context';
import { addDays, type Clock } from '../../core/time/clock';
import type { AuditService } from '../audit/audit.service';
import type { IamService, IssuedTokens } from './iam.service';
import { hashPassword, PASSWORD_MIN_LENGTH } from './passwords';
import { PERMISSIONS, ROLE_CODES, ROLE_TEMPLATES, type RoleCode } from './permissions';

const INVITATION_TTL_DAYS = 7;

export interface InvitationView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: Role[];
  status: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

export interface RoleTemplateView {
  roleCode: RoleCode;
  source: 'school' | 'default' | 'builtin';
  permissions: string[];
}

/**
 * Phase 2 IAM administration (ADR-0002 / ADR-0004): invitations, membership
 * lifecycle, role assignments and per-school role-template overrides.
 */
export class IamAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly iam: IamService,
    private readonly clock: Clock,
  ) {}

  private static invitationView(invitation: Invitation): InvitationView {
    return {
      id: invitation.id,
      email: invitation.email,
      firstName: invitation.firstName,
      lastName: invitation.lastName,
      roles: invitation.roles as Role[],
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      createdAt: invitation.createdAt,
    };
  }

  // ── Invitations ────────────────────────────────────────────────────────────

  async createInvitation(
    actorId: string,
    input: { email: string; firstName: string; lastName: string; roles: Role[] },
  ): Promise<InvitationView & { token: string }> {
    const schoolId = requireTenantSchoolId();
    const email = input.email.trim().toLowerCase();
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError(ErrorCodes.CONFLICT, `A user with email ${email} already exists.`);
    }
    const pending = await this.prisma.invitation.findFirst({ where: { email, status: 'PENDING' } });
    if (pending) {
      throw new AppError(ErrorCodes.CONFLICT, `A pending invitation for ${email} already exists.`);
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(token);
    const expiresAt = addDays(this.clock.now(), INVITATION_TTL_DAYS);

    const invitation = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invitation.create({
        data: {
          schoolId,
          email,
          firstName: input.firstName,
          lastName: input.lastName,
          roles: input.roles as PrismaRole[],
          tokenHash,
          invitedById: actorId,
          expiresAt,
        },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'iam.invitation.created',
        resourceType: 'invitation',
        resourceId: created.id,
        payload: { email, roles: input.roles, expiresAt: expiresAt.toISOString() },
      });
      return created;
    });
    return { ...IamAdminService.invitationView(invitation), token };
  }

  async listInvitations(params: { status?: 'PENDING' | 'ACCEPTED' | 'REVOKED'; limit: number }): Promise<InvitationView[]> {
    const invitations = await this.prisma.invitation.findMany({
      where: params.status ? { status: params.status } : {},
      orderBy: { createdAt: 'desc' },
      take: params.limit,
    });
    return invitations.map(IamAdminService.invitationView);
  }

  async revokeInvitation(actorId: string, invitationId: string): Promise<InvitationView> {
    const invitation = await this.prisma.invitation.findUnique({ where: { id: invitationId } });
    if (!invitation) throw new AppError(ErrorCodes.NOT_FOUND, 'Invitation not found.');
    if (invitation.status !== 'PENDING') {
      throw new AppError(ErrorCodes.CONFLICT, `Invitation is already ${invitation.status.toLowerCase()}.`);
    }
    const revoked = await this.prisma.$transaction(async (tx) => {
      await tx.invitation.update({ where: { id: invitation.id }, data: { status: 'REVOKED' } });
      await this.audit.append(tx, {
        actorId,
        action: 'iam.invitation.revoked',
        resourceType: 'invitation',
        resourceId: invitation.id,
        payload: { email: invitation.email },
      });
      return { ...invitation, status: 'REVOKED' as const };
    });
    return IamAdminService.invitationView(revoked);
  }

  /**
   * Public acceptance flow: the raw token identifies the invitation; the
   * invitee sets their own password (never derived or delivered by email in
   * this phase). Creates the global user identity + school membership +
   * role assignments atomically, then grants a first session.
   */
  async acceptInvitation(input: { token: string; password: string }): Promise<{
    user: { id: string; email: string; firstName: string; lastName: string; roles: Role[]; status: string };
    tokens: IssuedTokens;
  }> {
    if (input.password.length < PASSWORD_MIN_LENGTH) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    }
    const tokenHash = sha256Hex(input.token);
    const invitation = await runWithSystem(() => this.prisma.invitation.findUnique({ where: { tokenHash } }));
    if (!invitation || invitation.status !== 'PENDING') {
      throw new AppError(ErrorCodes.INVITATION_INVALID, 'Invitation is invalid or no longer usable.');
    }
    if (invitation.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError(ErrorCodes.INVITATION_EXPIRED, 'Invitation has expired. Ask an administrator for a new one.');
    }

    const passwordHash = await hashPassword(input.password);
    const acceptedAt = this.clock.now();
    let created;
    try {
      created = await runWithTenant(invitation.schoolId, () =>
        this.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email: invitation.email,
              passwordHash,
              firstName: invitation.firstName,
              lastName: invitation.lastName,
              roles: invitation.roles,
            },
          });
          const membership = await tx.membership.create({
            data: { schoolId: invitation.schoolId, userId: user.id, status: 'ACTIVE' },
          });
          for (const role of invitation.roles) {
            await tx.roleAssignment.create({
              data: { membershipId: membership.id, schoolId: invitation.schoolId, roleCode: role },
            });
          }
          const claimed = await tx.invitation.updateMany({
            where: { id: invitation.id, status: 'PENDING' },
            data: { status: 'ACCEPTED', acceptedAt, acceptedUserId: user.id },
          });
          if (claimed.count === 0) {
            throw new AppError(ErrorCodes.INVITATION_INVALID, 'Invitation is invalid or no longer usable.');
          }
          await this.audit.append(tx, {
            actorId: null,
            action: 'iam.invitation.accepted',
            resourceType: 'invitation',
            resourceId: invitation.id,
            payload: { email: invitation.email, userId: user.id, roles: invitation.roles },
          });
          return user;
        }),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        throw new AppError(ErrorCodes.CONFLICT, `A user with email ${invitation.email} already exists.`);
      }
      throw error;
    }

    const tokens = await this.iam.issueLoginTokensFor(created.id);
    return {
      user: {
        id: created.id,
        email: created.email,
        firstName: created.firstName,
        lastName: created.lastName,
        roles: created.roles as Role[],
        status: created.status,
      },
      tokens,
    };
  }

  // ── Membership lifecycle ───────────────────────────────────────────────────

  async setMembershipStatus(
    actorId: string,
    targetUserId: string,
    status: Extract<MembershipStatus, 'ACTIVE' | 'SUSPENDED'>,
    reason?: string,
  ): Promise<{ userId: string; membershipId: string; status: MembershipStatus }> {
    if (status === 'SUSPENDED' && targetUserId === actorId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'You cannot suspend your own membership.');
    }
    const membership = await this.prisma.membership.findFirst({ where: { userId: targetUserId } });
    if (!membership) throw new AppError(ErrorCodes.NOT_FOUND, 'This user has no membership in your school.');
    if (membership.status === status) {
      throw new AppError(ErrorCodes.CONFLICT, `Membership is already ${status.toLowerCase()}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: membership.id }, data: { status } });
      await this.audit.append(tx, {
        actorId,
        action: status === 'SUSPENDED' ? 'iam.membership.suspended' : 'iam.membership.activated',
        resourceType: 'membership',
        resourceId: membership.id,
        payload: { userId: targetUserId, ...(reason ? { reason } : {}) },
      });
    });
    return { userId: targetUserId, membershipId: membership.id, status };
  }

  // ── Role assignments ───────────────────────────────────────────────────────

  async updateRoles(actorId: string, targetUserId: string, roles: Role[]): Promise<{ userId: string; roles: Role[] }> {
    const membership = await this.prisma.membership.findFirst({
      where: { userId: targetUserId },
      include: { assignments: { select: { roleCode: true } } },
    });
    if (!membership) throw new AppError(ErrorCodes.NOT_FOUND, 'This user has no membership in your school.');
    const previous = membership.assignments.map((assignment) => assignment.roleCode);

    await this.prisma.$transaction(async (tx) => {
      await tx.roleAssignment.deleteMany({ where: { membershipId: membership.id } });
      for (const role of roles) {
        await tx.roleAssignment.create({
          data: { membershipId: membership.id, schoolId: membership.schoolId, roleCode: role },
        });
      }
      // Transitional mirror (ADR-0002): single-membership users keep `User.roles` in sync.
      const membershipCount = await tx.membership.count({ where: { userId: targetUserId } });
      if (membershipCount === 1) {
        await tx.user.update({ where: { id: targetUserId }, data: { roles: roles as PrismaRole[] } });
      }
      await this.audit.append(tx, {
        actorId,
        action: 'iam.user.roles_updated',
        resourceType: 'user',
        resourceId: targetUserId,
        payload: { roles, previous },
      });
    });
    return { userId: targetUserId, roles };
  }

  // ── Role templates (per-school overrides) ──────────────────────────────────

  private async schoolMode(): Promise<SchoolMode> {
    const schoolId = requireTenantSchoolId();
    const policy = await this.prisma.schoolPolicy.findUnique({ where: { schoolId }, select: { mode: true } });
    return policy?.mode ?? 'HE';
  }

  async listRoleTemplates(): Promise<{ mode: SchoolMode; templates: RoleTemplateView[] }> {
    const schoolId = requireTenantSchoolId();
    const mode = await this.schoolMode();
    const rows = await this.prisma.roleTemplate.findMany({
      where: { mode, OR: [{ schoolId }, { schoolId: null }] },
      include: { permissions: { select: { permissionCode: true } } },
    });
    const schoolRows = new Map<string, string[]>();
    const defaultRows = new Map<string, string[]>();
    for (const row of rows) {
      const codes = row.permissions.map((permission) => permission.permissionCode);
      (row.schoolId === null ? defaultRows : schoolRows).set(row.roleCode, codes);
    }
    const builtin = new Map<string, readonly string[]>(
      ROLE_TEMPLATES.filter((template) => template.mode === mode).map((template) => [template.roleCode, template.permissions]),
    );
    const templates: RoleTemplateView[] = ROLE_CODES.map((roleCode) => {
      const school = schoolRows.get(roleCode);
      if (school) return { roleCode, source: 'school', permissions: school };
      const defaultRow = defaultRows.get(roleCode);
      if (defaultRow) return { roleCode, source: 'default', permissions: defaultRow };
      return { roleCode, source: 'builtin', permissions: [...(builtin.get(roleCode) ?? [])] };
    });
    return { mode, templates };
  }

  async setRoleTemplate(actorId: string, roleCode: RoleCode, permissions: string[]): Promise<RoleTemplateView> {
    if (roleCode === 'ADMIN') {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'The ADMIN template is fixed and cannot be overridden.');
    }
    const registry = new Set(PERMISSIONS.map((permission) => permission.code));
    const codes = [...new Set(permissions)];
    const invalidCodes = codes.filter((code) => !registry.has(code));
    if (invalidCodes.length > 0) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Unknown permission codes.', { meta: { invalidCodes } });
    }

    const schoolId = requireTenantSchoolId();
    const mode = await this.schoolMode();
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.roleTemplate.findFirst({ where: { schoolId, roleCode, mode } });
      const template =
        existing ??
        (await tx.roleTemplate.create({ data: { schoolId, roleCode, mode } }));
      await tx.roleTemplatePermission.deleteMany({ where: { templateId: template.id } });
      if (codes.length > 0) {
        // The registry table backs a FK: self-heal fresh databases where seed
        // has not run yet (the static registry is the source of truth).
        await tx.permission.createMany({
          data: codes.map((code) => {
            const spec = PERMISSIONS.find((permission) => permission.code === code)!;
            return { code, module: spec.module, description: spec.description };
          }),
          skipDuplicates: true,
        });
        await tx.roleTemplatePermission.createMany({
          data: codes.map((permissionCode) => ({ templateId: template.id, permissionCode })),
        });
      }
      await this.audit.append(tx, {
        actorId,
        action: 'iam.template.updated',
        resourceType: 'role_template',
        resourceId: template.id,
        payload: { roleCode, mode, permissions: codes },
      });
    });
    return { roleCode, source: 'school', permissions: codes };
  }

  async revertRoleTemplate(actorId: string, roleCode: RoleCode): Promise<void> {
    if (roleCode === 'ADMIN') {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'The ADMIN template is fixed and cannot be overridden.');
    }
    const schoolId = requireTenantSchoolId();
    const mode = await this.schoolMode();
    const existing = await this.prisma.roleTemplate.findFirst({
      where: { schoolId, roleCode, mode },
      include: { permissions: { select: { permissionCode: true } } },
    });
    if (!existing) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'No school-specific override exists for this role.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.roleTemplatePermission.deleteMany({ where: { templateId: existing.id } });
      await tx.roleTemplate.delete({ where: { id: existing.id } });
      await this.audit.append(tx, {
        actorId,
        action: 'iam.template.reverted',
        resourceType: 'role_template',
        resourceId: existing.id,
        payload: { roleCode, mode, previousPermissions: existing.permissions.map((permission) => permission.permissionCode) },
      });
    });
  }
}
