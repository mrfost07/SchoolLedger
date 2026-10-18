import { Worker, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { PrismaClient } from '@prisma/client';
import {
  QUEUE_NAMES,
  registerIncSweepSchedule,
  type DocumentRenderJob,
  type Queues,
  type WaitlistPromotionJob,
} from './infra/queues';
import { cleanupExpiredIdempotencyKeys } from './core/http/idempotency';
import { runWithSystem, runWithTenant } from './core/tenant/context';
import type { ComposedServices } from './app';

export interface RunningWorkers {
  close(): Promise<void>;
}

/**
 * BullMQ consumer processes. Each handler delegates to the same service used
 * by the API, so behavior is identical in inline (test/degraded) mode.
 */
export async function startWorkers(deps: {
  redis: Redis;
  queues: Queues;
  services: ComposedServices;
  prisma: PrismaClient;
  logger: Logger;
}): Promise<RunningWorkers> {
  const connection = deps.redis as unknown as ConnectionOptions;

  const documentWorker = new Worker<DocumentRenderJob>(
    QUEUE_NAMES.documents,
    async (job) => runWithTenant(job.data.schoolId, () => deps.services.documentWorker.render(job.data)),
    { connection, concurrency: 2 },
  );

  const waitlistWorker = new Worker<WaitlistPromotionJob>(
    QUEUE_NAMES.waitlist,
    async (job) => {
      await runWithTenant(job.data.schoolId, () =>
        deps.services.waitlist.promote(job.data.termId, job.data.sectionId),
      );
    },
    { connection, concurrency: 4 },
  );

  const incWorker = new Worker<Record<string, never>>(
    QUEUE_NAMES.incSweep,
    async () => {
      await runWithSystem(async () => {
        await deps.services.inc.sweepExpired();
        // Same hourly cadence: reap idempotency keys whose 24h TTL elapsed.
        await cleanupExpiredIdempotencyKeys(deps.prisma).catch(() => undefined);
      });
    },
    { connection, concurrency: 1 },
  );

  const all = [documentWorker, waitlistWorker, incWorker];
  for (const worker of all) {
    worker.on('failed', (job, error) => {
      deps.logger.error({ queue: worker.name, jobId: job?.id, attempt: job?.attemptsMade, err: error.message }, 'worker job failed');
    });
    worker.on('error', (error) => {
      deps.logger.error({ queue: worker.name, err: error.message }, 'worker connection error');
    });
  }

  await registerIncSweepSchedule(deps.queues);

  return {
    close: async () => {
      await Promise.all(all.map((worker) => worker.close()));
    },
  };
}
