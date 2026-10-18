import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import type { Clock } from './core/time/clock';
import type { StoragePort } from './infra/storage';

/**
 * Background work boundary. The BullMQ-backed dispatcher enqueues durable
 * jobs; the inline dispatcher runs handlers in-process (used in tests and in
 * degraded mode when Redis is unavailable).
 */
export interface BackgroundDispatcher {
  readonly mode: 'bullmq' | 'inline';
  enqueueDocumentRender(schoolId: string, documentId: string): Promise<void>;
  enqueueWaitlistPromotion(schoolId: string, termId: string, sectionId: string): Promise<void>;
}

export interface AppContext {
  config: Env;
  prisma: PrismaClient;
  redis: Redis | null;
  storage: StoragePort;
  clock: Clock;
  logger: Logger;
}
