import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCodes, AppError } from '../errors/taxonomy';
import { verifyJwt, type JwtPayload } from '../crypto/jwt';
import { setTenantSchool } from '../tenant/context';
import { ROLE_TEMPLATES } from '../../modules/iam/permissions';
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
 * declare `config.permission`; role templates grant them. School-specific
 * overrides via `role_templates` rows (school policy mode) land in the
 * configuration phase — until then enforcement reads the seeded registry.
 */
const HE_PERMISSIONS_BY_ROLE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  ROLE_TEMPLATES.filter((template) => template.mode === 'HE').map((template) => [
    template.roleCode as string,
    new Set<string>(template.permissions),
  ]),
);

export function effectivePermissions(roles: readonly string[]): Set<string> {
  const permissions = new Set<string>();
  for (const role of roles) {
    const granted = HE_PERMISSIONS_BY_ROLE.get(role);
    if (granted) for (const code of granted) permissions.add(code);
  }
  return permissions;
}

/** Any-of guard: passes when the caller holds at least one of `codes`. */
export function requirePermission(
  request: FastifyRequest,
  config: Pick<Env, 'jwtAccessSecret'>,
  codes: readonly string[],
): AuthUser {
  const auth = requireAuth(request, config);
  const permissions = effectivePermissions(auth.roles);
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
