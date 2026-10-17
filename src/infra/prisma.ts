import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export function createPrismaClient(databaseUrl: string, logQueries = false): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: logQueries ? [{ emit: 'event', level: 'query' }] : ['warn', 'error'],
  });
}

