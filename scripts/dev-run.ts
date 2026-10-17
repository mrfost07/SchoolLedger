/* eslint-disable no-console */
/**
 * Dev infrastructure bootstrapper for machines without Docker:
 * boots embedded PostgreSQL + redis-memory-server, applies migrations and
 * seeds the demo data, then prints READY and stays alive.
 *
 * Usage (from repo root):
 *   node node_modules/tsx/dist/cli.mjs scripts/dev-run.ts
 * The printed DATABASE_URL / REDIS_URL must be passed to the app process env.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { RedisMemoryServer } from 'redis-memory-server';

const PG_PORT = Number.parseInt(process.env.DEV_PG_PORT ?? '5433', 10);
const DB_NAME = 'students_portal_dev';

export const DEV_SECRETS = {
  JWT_ACCESS_SECRET: 'dev-access-secret',
  JWT_MFA_SECRET: 'dev-mfa-secret',
  DOCUMENT_HMAC_SECRET: 'dev-document-hmac-secret',
  PRESIGN_SECRET: 'dev-presign-secret',
} as const;

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'studentsportal-dev-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
  });

  console.log('[dev-infra] initialising embedded postgres…');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  const databaseUrl = `postgresql://postgres:postgres@localhost:${PG_PORT}/${DB_NAME}`;
  console.log(`[dev-infra] postgres up: ${databaseUrl}`);

  const prismaCli = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
  console.log('[dev-infra] applying migrations…');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PGCLIENTENCODING: 'UTF8' },
    stdio: 'inherit',
  });

  console.log('[dev-infra] booting redis…');
  const rms = await RedisMemoryServer.create();
  const redisHost = await rms.getHost();
  const redisPort = await rms.getPort();
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  console.log(`[dev-infra] redis up: ${redisUrl}`);

  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  console.log('[dev-infra] seeding demo data…');
  execFileSync(process.execPath, [tsxCli, 'prisma/seed.ts'], {
    env: {
      ...process.env,
      ...DEV_SECRETS,
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      PGCLIENTENCODING: 'UTF8',
    },
    stdio: 'inherit',
  });

  const runtimeFile = join(process.cwd(), '.dev-runtime.json');
  writeFileSync(
    runtimeFile,
    JSON.stringify({ databaseUrl, redisUrl, secrets: DEV_SECRETS }, null, 2),
    'utf8',
  );

  const shutdown = async (): Promise<void> => {
    await rms.stop().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  console.log('READY');
  console.log(`DATABASE_URL=${databaseUrl}`);
  console.log(`REDIS_URL=${redisUrl}`);
  setInterval(() => undefined, 1 << 30);
}

void main().catch((error) => {
  console.error('[dev-infra] failed:', error);
  process.exit(1);
});
