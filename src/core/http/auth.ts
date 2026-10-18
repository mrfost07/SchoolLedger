import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { ErrorCodes, AppError } from '../errors/taxonomy';
import { verifyJwt, type JwtPayload } from '../crypto/jwt';
import { setTenantSchool } from '../tenant/context';
import { PERMISSIONS, ROLE_TEMPLATES } from '../../modules/iam/permissions';
import type { Env } from '../../config/env';

export type Role = 'STUDENT' | 'INSTRUCTOR' | 'PROGRAM_CHAIR' | 'REGISTRAR' | 'CASHIER' | 'ADMIN';

export interface AuthUser {
  userId: string;
  /** Active school membership at token issuance (ADR-0001). */
  schoolId: string;
  roles: Role[];
  sessionId: string | null;
  /** True when this access token carries a *fresh* step-up MFA elevation. */
  mfa: boolean;
  /** Epoch seconds of the MFA elevation, if any. */
  mfaAt: number | null;
  tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthUser;
  }
}

export function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Missing bearer token');
  }
  return header.slice('Bearer '.length).trim();
}

export function authenticate(request: FastifyRequest, config: Pick<Env, 'jwtAccessSecret'>): AuthUser {
  const payload: JwtPayload = verifyJwt(bearerToken(request), config.jwtAccessSecret, new Date());
  if (payload.typ !== 'access') throw new AppError(ErrorCodes.TOKEN_INVALID, 'Expected an access token');
  if (!payload.schoolId) throw new AppError(ErrorCodes.TOKEN_INVALID, 'Token is not scoped to a school');
  const auth: AuthUser = {
    userId: payload.sub,
    schoolId: payload.schoolId,
    roles: (payload.roles ?? []) as Role[],
    sessionId: payload.sid ?? null,
    mfa: payload.mfa === true,
    mfaAt: typeof payload.mfaAt === 'number' ? payload.mfaAt : null,
    tokenId: payload.jti,
  };
  setTenantSchool(auth.schoolId);
  request.auth = auth;
  return auth;
}

export function requireAuth(request: FastifyRequest, config: Pick<Env, 'jwtAccessSecret'>): AuthUser {
  if (request.auth) return request.auth;
  return authenticate(request, config);
}

export function requireRoles(
  request: FastifyRequest,
  config: Pick<Env, 'jwtAccessSecret'>,
  ...roles: Role[]
): AuthUser {
  const auth = requireAuth(request, config);
  const allowed = roles.length === 0 || auth.roles.some((role) => roles.includes(role));
  if (!allowed) {
    throw new AppError(ErrorCodes.FORBIDDEN, `Requires one of roles: ${roles.join(', ')}`);
  }
  return auth;
}

/**
 * Built-in HE permission resolution (ADR-0004). Permissions are data: routes
 * declare `config.permission`; role templates grant them. Enrollment reads
 * school-specific `role_templates` overrides first, then the school-less
 * default rows, then falls back to this seeded registry (empty DBs, tests).
 */
const HE_PERMISSIONS_BY_ROLE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ROLE_TEMPLATES.filter((template) => template.mode === 'HE').map((template) => [
    template.roleCode as string,
    new Set<string>(template.permissions),
  ]),
);

export type PermissionResolverPrisma = Pick<PrismaClient, 'schoolPolicy' | 'roleTemplate'>;

/** One resolution per request: the token's roles cannot change mid-request. */
const requestPermissionCache = new WeakMap<FastifyRequest, Map<string, Promise<Set<string>>>>();

async function resolveEffectivePermissions(
  prisma: PermissionResolverPrisma,
  schoolId: string,
  roles: readonly string[],
): Promise<Set<string>> {
  // ADMIN is non-overridable: always the full registry (ADR-0004).
  if (roles.includes('ADMIN')) {
    return new Set(PERMISSIONS.map((permission) => permission.code));
  }
  const policy = await prisma.schoolPolicy.findUnique({ where: { schoolId }, select: { mode: true } });
  const mode = policy?.mode ?? 'HE';
  const rows = await prisma.roleTemplate.findMany({
    where: { mode, roleCode: { in: [...roles] }, OR: [{ schoolId }, { schoolId: null }] },
    select: {
      schoolId: true,
      roleCode: true,
      permissions: { select: { permissionCode: true } },
    },
  });
  const schoolRows = new Map<string, Set<string>>();
  const defaultRows = new Map<string, Set<string>>();
  for (const row of rows) {
    const target = row.schoolId === null ? defaultRows : schoolRows;
    target.set(row.roleCode, new Set(row.permissions.map((permission) => permission.permissionCode)));
  }
  const permissions = new Set<string>();
  for (const role of roles) {
    const granted = schoolRows.get(role) ?? defaultRows.get(role) ?? HE_PERMISSIONS_BY_ROLE.get(role);
    if (granted) for (const code of granted) permissions.add(code);
  }
  return permissions;
}

/** Any-of guard: passes when the caller holds at least one of `codes`. */
export async function requirePermission(
  request: FastifyRequest,
  config: Pick<Env, 'jwtAccessSecret'>,
  codes: readonly string[],
  prisma: PermissionResolverPrisma,
): Promise<AuthUser> {
  const auth = requireAuth(request, config);
  let byKey = requestPermissionCache.get(request);
  if (!byKey) {
    byKey = new Map();
    requestPermissionCache.set(request, byKey);
  }
  const key = `${auth.schoolId}:${auth.roles.join(',')}`;
  let pending = byKey.get(key);
  if (!pending) {
    pending = resolveEffectivePermissions(prisma, auth.schoolId, auth.roles);
    byKey.set(key, pending);
  }
  const permissions = await pending;
  if (!codes.some((code) => permissions.has(code))) {
    throw new AppError(ErrorCodes.FORBIDDEN, `Requires permission: ${codes.join(' or ')}`);
  }
  return auth;
}

/**
 * Step-up MFA guard (BSL-005). Requires an access token minted through
 * POST /auth/step-up within the configured window.
 */
export function requireStepUpMfa(
  request: FastifyRequest,
  config: Pick<Env, 'jwtAccessSecret' | 'stepUpTtlMinutes'>,
): AuthUser {
  const auth = requireAuth(request, config);
  if (!auth.mfa || auth.mfaAt === null) {
    throw new AppError(ErrorCodes.STEP_UP_REQUIRED, 'This action requires a fresh step-up MFA verification.');
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - auth.mfaAt;
  if (ageSeconds > config.stepUpTtlMinutes * 60 || ageSeconds < -30) {
    throw new AppError(ErrorCodes.STEP_UP_REQUIRED, 'MFA elevation has expired; verify again.');
  }
  return auth;
}

export function clientIp(request: FastifyRequest): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0]!.trim();
  return request.ip;
}
