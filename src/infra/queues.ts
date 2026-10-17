import { Queue, type ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { BackgroundDispatcher } from '../context';

export const QUEUE_NAMES = {
  documents: 'documents.render',
  waitlist: 'enrollment.promote',
  incSweep: 'grading.inc-sweep',
} as const;

export interface DocumentRenderJob {
  documentId: string;
}

export interface WaitlistPromotionJob {
  termId: string;
  sectionId: string;
}

export interface Queues {
  documents: Queue<DocumentRenderJob>;
  waitlist: Queue<WaitlistPromotionJob>;
  incSweep: Queue<Record<string, never>>;
  close(): Promise<void>;
}

export function createQueues(redis: Redis): Queues {
  const connection = redis as unknown as ConnectionOptions;
  const documents = new Queue<DocumentRenderJob>(QUEUE_NAMES.documents, { connection });
  const waitlist = new Queue<WaitlistPromotionJob>(QUEUE_NAMES.waitlist, { connection });
  const incSweep = new Queue<Record<string, never>>(QUEUE_NAMES.incSweep, { connection });
  return {
    documents,
    waitlist,
    incSweep,
    close: async () => {
      await Promise.all([documents.close(), waitlist.close(), incSweep.close()]);
    },
  };
}

/**
 * Enqueues the INC sweep as a repeatable job (hourly). Idempotent: the job
 * scheduler is upserted by id; safe to call on every boot.
 */
export async function registerIncSweepSchedule(queues: Queues): Promise<void> {
  await queues.incSweep.upsertJobScheduler(
    'inc-sweep-hourly',
    { pattern: '0 * * * *' },
    { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 50 } },
  );
}

export function createBullDispatcher(queues: Queues): BackgroundDispatcher {
  return {
    mode: 'bullmq',
    async enqueueDocumentRender(documentId: string) {
      await queues.documents.add('render', { documentId }, { removeOnComplete: 500, removeOnFail: 500 });
    },
    async enqueueWaitlistPromotion(termId: string, sectionId: string) {
      await queues.waitlist.add(
        'promote',
        { termId, sectionId },
        { jobId: `promote:${sectionId}`, removeOnComplete: 500, removeOnFail: 500 },
      );
    },
  };
}

export interface InlineHandlers {
  renderDocument(documentId: string): Promise<void>;
  promoteWaitlist(termId: string, sectionId: string): Promise<void>;
}

/** Executes background handlers inline — used by tests and degraded mode. */
export function createInlineDispatcher(handlers: InlineHandlers): BackgroundDispatcher {
  return {
    mode: 'inline',
    async enqueueDocumentRender(documentId: string) {
      await handlers.renderDocument(documentId);
    },
    async enqueueWaitlistPromotion(termId: string, sectionId: string) {
      await handlers.promoteWaitlist(termId, sectionId);
    },
  };
}
