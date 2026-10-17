/* eslint-disable no-console */
/**
 * Wipes the dev database and flushes redis (idempotency + sessions + queues),
 * so the walkthrough starts from the seeded baseline. Run before `seed`.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
  );
  if (tables.length > 0) {
    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await prisma.$disconnect();

  const redis = new Redis(redisUrl);
  await redis.flushall();
  await redis.quit();

  console.log(`[dev-reset] truncated ${tables.length} tables, flushed redis`);
}

void main().catch((error) => {
  console.error('[dev-reset] failed:', error);
  process.exit(1);
});
