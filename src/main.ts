import pino from 'pino';
import { loadEnv } from './config/env';
import { createPrismaClient } from './infra/prisma';
import { connectRedis } from './infra/redis';
import { createStorage } from './infra/storage';
import { systemClock } from './core/time/clock';
import { buildApp, composeServices } from './app';
import { startWorkers, type RunningWorkers } from './workers';
import type { AppContext } from './context';

async function main(): Promise<void> {
  const config = loadEnv();
  const logger = pino({
    level: config.logLevel,
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });

  const prisma = createPrismaClient(config.databaseUrl);
  const { redis, degraded } = await connectRedis(config.redisUrl, config.redisRequired, logger);
  const storage = await createStorage(config);

  const ctx: AppContext = { config, prisma, redis, storage, clock: systemClock, logger };
  const services = composeServices(ctx);
  const app = buildApp(ctx, services);

  let workers: RunningWorkers | null = null;
  if (config.workersEnabled && services.queues && redis) {
    workers = await startWorkers({ redis, queues: services.queues, services, prisma, logger });
    logger.info('background workers started (documents, waitlist, inc-sweep)');
  } else if (degraded) {
    logger.warn('no redis: jobs execute inline, capacity gate falls back to database row locks');
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info({ port: config.port, env: config.nodeEnv }, 'SchoolLedger API listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');
    try {
      await app.close();
      await workers?.close();
      await services.close();
      await prisma.$disconnect();
      await redis?.quit().catch(() => undefined);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error', error);
  process.exit(1);
});
