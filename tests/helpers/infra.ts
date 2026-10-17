import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

export interface TestInfra {
  prisma: PrismaClient;
  redis: Redis;
  databaseUrl: string;
  storageDir: string;
  resetDatabase(): Promise<void>;
}

const globalRef = globalThis as unknown as { __studentsPortalInfra?: Promise<TestInfra> };

const PG_PORT = Number.parseInt(process.env.TEST_PG_PORT ?? '23457', 10);

const DEBUG = process.env.TEST_INFRA_DEBUG === '1';
const step = (message: string): void => {
  if (DEBUG) console.error(`[infra] ${message} @ ${Date.now()}`);
};

/**
 * Boots the shared test infrastructure exactly once per process:
 *  - embedded PostgreSQL (migrations applied via `prisma migrate deploy`)
 *  - redis-memory-server (Lua supported, verifies the real capacity scripts)
 * Vitest runs single-fork, so the cache survives across test files while each
 * file gets a clean database via `resetDatabase()`.
 */
export function getTestInfra(): Promise<TestInfra> {
  globalRef.__studentsPortalInfra ??= start();
  return globalRef.__studentsPortalInfra;
}

async function start(): Promise<TestInfra> {
  step('importing embedded-postgres / redis-memory-server');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const { RedisMemoryServer } = await import('redis-memory-server');
  const { PrismaClient } = await import('@prisma/client');
  const { default: RedisClient } = await import('ioredis');

  const dataDir = mkdtempSync(join(tmpdir(), 'studentsportal-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
  });
  step('initialising postgres');
  await pg.initialise();
  step('starting postgres');
  await pg.start();
  step('creating database');
  await pg.createDatabase('portal_test');

  const databaseUrl = `postgresql://postgres:postgres@localhost:${PG_PORT}/portal_test`;

  step('running prisma migrate deploy');
  const prismaCli = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PGCLIENTENCODING: 'UTF8' },
    stdio: 'pipe',
  });
  step('starting redis-memory-server');
  const rms = await RedisMemoryServer.create();
  const redisHost = await rms.getHost();
  const redisPort = await rms.getPort();
  const redis = new RedisClient(`redis://${redisHost}:${redisPort}`, { maxRetriesPerRequest: null });
  await redis.ping();
  step('connecting prisma client');

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$queryRaw`SELECT 1`;
  step('infra ready');

  const storageDir = mkdtempSync(join(tmpdir(), 'studentsportal-storage-'));

  const cleanup = async (): Promise<void> => {
    await prisma.$disconnect().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await rms.stop().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  };
  process.once('beforeExit', () => void cleanup());

  return {
    prisma,
    redis,
    databaseUrl,
    storageDir,
    async resetDatabase(): Promise<void> {
      const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
      );
      if (tables.length > 0) {
        const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
      }
      await redis.flushall();
    },
  };
}
