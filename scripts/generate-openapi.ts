import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { loadEnv } from '../src/config/env';
import { buildApp, composeServices } from '../src/app';
import { createPrismaClient } from '../src/infra/prisma';
import { createStorage } from '../src/infra/storage';
import { systemClock } from '../src/core/time/clock';
import type { AppContext } from '../src/context';

async function main(): Promise<void> {
  process.env.DATABASE_URL ||= 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
  process.env.JWT_ACCESS_SECRET ||= 'openapi-generation-secret-not-used-at-runtime';
  process.env.DOCUMENT_HMAC_SECRET ||= 'openapi-generation-hmac-not-used-at-runtime';

  const config = loadEnv();
  const logger = pino({ level: 'silent' });
  const prisma = createPrismaClient(config.databaseUrl);
  const storage = await createStorage(config);

  const ctx: AppContext = { config, prisma, redis: null, storage, clock: systemClock, logger };
  const services = composeServices(ctx);
  const app = buildApp(ctx, services);

  await app.ready();
  const spec = app.swagger();
  const outPath = join(process.cwd(), 'openapi.json');
  writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  await app.close();
  await services.close();
  await prisma.$disconnect();

  const paths = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {}).length;
  // eslint-disable-next-line no-console
  console.log(`openapi.json written (${paths} paths, OpenAPI ${(spec as { openapi?: string }).openapi})`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('openapi generation failed', error);
  process.exit(1);
});
