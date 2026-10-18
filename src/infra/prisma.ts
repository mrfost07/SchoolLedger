import { Prisma, PrismaClient } from '@prisma/client';
import { tenantExtension } from '../core/tenant/extension';

export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Creates the runtime Prisma client with the fail-closed tenant scoping
 * extension applied. Every model in TENANT_MODELS requires an explicit
 * tenant/system context frame (see core/tenant/context.ts).
 *
 * Test fixtures/assertions that intentionally operate outside a tenant frame
 * use a bare client (`new PrismaClient`) as the admin escape hatch.
 */
export function createPrismaClient(databaseUrl: string, logQueries = false): PrismaClient {
  const base = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: logQueries ? [{ emit: 'event', level: 'query' }] : ['warn', 'error'],
  });
  return base.$extends(tenantExtension) as unknown as PrismaClient;
}
