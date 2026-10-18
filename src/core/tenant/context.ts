import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError, ErrorCodes } from '../errors/taxonomy';

/**
 * Request-scoped tenant context (ADR-0001).
 *
 * The store is established per HTTP request (see buildApp onRequest hook) and
 * mutated by the auth layer once the JWT is verified. Background jobs run
 * inside an explicit `runWithTenant`/`runWithSystem` frame.
 *
 * `schoolId: null` + `system: false` means "authenticated request not yet
 * resolved" — tenant-table access without a school is rejected by the Prisma
 * tenant extension (fail closed).
 */
export interface TenantStore {
  /** The school every tenant-table operation is scoped to. */
  schoolId: string | null;
  /** Platform/system context: tenant scoping is bypassed (migrations, seeds, login resolution, ops). */
  system: boolean;
}

const storage = new AsyncLocalStorage<TenantStore>();

export function runWithStore<T>(store: TenantStore, fn: () => T): T {
  return storage.run(store, fn);
}

/**
 * Runs `fn` scoped to a single school. The returned promise is settled while
 * the frame is still active: Prisma promises are lazy, so their query
 * interceptors execute at await-time and must observe the tenant frame.
 */
export function runWithTenant<T>(schoolId: string, fn: () => T): Promise<Awaited<T>> {
  return storage.run({ schoolId, system: false }, async (): Promise<Awaited<T>> => (await fn()) as Awaited<T>);
}

/**
 * Runs `fn` in platform/system context. Callers take responsibility for
 * scoping every query themselves (or intentionally operating cross-tenant).
 */
export function runWithSystem<T>(fn: () => T): Promise<Awaited<T>> {
  return storage.run({ schoolId: null, system: true }, async (): Promise<Awaited<T>> => (await fn()) as Awaited<T>);
}

export function getTenantStore(): TenantStore | undefined {
  return storage.getStore();
}

/** Binds the authenticated school onto the current request store. */
export function setTenantSchool(schoolId: string): void {
  const store = storage.getStore();
  if (!store) {
    throw new AppError(ErrorCodes.TENANT_CONTEXT_MISSING, 'No tenant context frame for this request.');
  }
  store.schoolId = schoolId;
}

/**
 * Resolves the school the current operation must be scoped to, or throws.
 * System context has no single school and must use `runWithTenant` when a
 * school-scoped operation is performed.
 */
export function requireTenantSchoolId(): string {
  const store = storage.getStore();
  if (!store) {
    throw new AppError(ErrorCodes.TENANT_CONTEXT_MISSING, 'No tenant context frame for this operation.');
  }
  if (!store.schoolId) {
    throw new AppError(
      ErrorCodes.TENANT_CONTEXT_MISSING,
      store.system
        ? 'Operation requires a school-scoped context; wrap it in runWithTenant(schoolId).'
        : 'No school bound to this request.',
    );
  }
  return store.schoolId;
}
