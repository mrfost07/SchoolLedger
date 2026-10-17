import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Redis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import type { Interval } from '../academics/conflicts';

export interface ReservationSection {
  sectionId: string;
  maxCapacity: number;
  enrolledCount: number;
  intervals: Interval[];
}

export interface ReservationRequest {
  studentId: string;
  termId: string;
  sections: ReservationSection[];
}

export type ReservationOutcome =
  | { ok: true }
  | {
      ok: false;
      code: 'SECTION_FULL' | 'STUDENT_CONFLICT' | 'BATCH_CONFLICT';
      sectionIds: string[];
      meta?: Record<string, unknown>;
    };

export interface CapacityGate {
  readonly kind: 'redis' | 'database';
  ensureInitialized(termId: string, sections: Array<{ sectionId: string; maxCapacity: number; enrolledCount: number }>): Promise<void>;
  tryReserve(request: ReservationRequest): Promise<ReservationOutcome>;
  release(request: ReservationRequest): Promise<void>;
  syncSection(termId: string, sectionId: string, remaining: number): Promise<void>;
}

const SLOT_TTL_SECONDS = 200 * 86_400; // section counters persist for the term
const SCHEDULE_TTL_SECONDS = 200 * 86_400;

function loadLua(name: string): string {
  const candidates = [
    join(__dirname, 'lua', name),
    join(__dirname, '..', '..', '..', 'src', 'modules', 'enrollment', 'lua', name),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try next candidate (handles tsx vs dist layout)
    }
  }
  throw new Error(`Lua script not found: ${name}`);
}

export function encodeReservationPayload(sections: Array<{ sectionId: string; intervals: Interval[] }>): string {
  return sections
    .map(
      (section) =>
        `${section.sectionId}@${section.intervals
          .map((interval) => `${interval.dayOfWeek}:${interval.startMin}:${interval.endMin}`)
          .join(';')}`,
    )
    .join('|');
}

export const slotKey = (termId: string, sectionId: string) => `sec:{${termId}}:${sectionId}:slots`;
export const studentScheduleKey = (termId: string, studentId: string) => `stu:{${termId}}:${studentId}:sched`;

/**
 * Redis-authoritative admission control (BSL-202).
 * The Lua script is atomic: capacity + schedule overlap + decrement happen in
 * one round trip, so concurrent requests from the same student cannot both
 * pass the overlap check and no two requests can oversubscribe a section.
 * Postgres remains the source of truth (see EnrollmentService.reserve).
 */
export class RedisCapacityGate implements CapacityGate {
  readonly kind = 'redis' as const;
  private readonly reserveScript = loadLua('reserve_slots.lua');
  private readonly releaseScript = loadLua('release_slots.lua');

  constructor(private readonly redis: Redis) {}

  async ensureInitialized(
    termId: string,
    sections: Array<{ sectionId: string; maxCapacity: number; enrolledCount: number }>,
  ): Promise<void> {
    if (sections.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const section of sections) {
      const remaining = Math.max(0, section.maxCapacity - section.enrolledCount);
      pipeline.set(slotKey(termId, section.sectionId), String(remaining), 'EX', SLOT_TTL_SECONDS, 'NX');
    }
    await pipeline.exec();
  }

  async tryReserve(request: ReservationRequest): Promise<ReservationOutcome> {
    const keys = [
      studentScheduleKey(request.termId, request.studentId),
      ...request.sections.map((section) => slotKey(request.termId, section.sectionId)),
    ];
    const payload = encodeReservationPayload(request.sections);
    const result = (await this.redis.eval(this.reserveScript, keys.length, ...keys, String(SCHEDULE_TTL_SECONDS), payload)) as string;

    if (result === 'OK') return { ok: true };
    if (result === 'BAD_PAYLOAD') {
      return { ok: false, code: 'SECTION_FULL', sectionIds: [], meta: { reason: 'BAD_PAYLOAD' } };
    }
    if (result.startsWith('MISSING_SLOTS:')) {
      // Counters not initialized — treat as a cache miss. The caller falls back
      // to the database path, which is authoritative.
      return { ok: false, code: 'SECTION_FULL', sectionIds: [result.slice('MISSING_SLOTS:'.length)], meta: { missingSlots: true } };
    }
    if (result.startsWith('SECTION_FULL:')) {
      return { ok: false, code: 'SECTION_FULL', sectionIds: [result.slice('SECTION_FULL:'.length)] };
    }
    if (result.startsWith('STUDENT_CONFLICT:')) {
      const rest = result.slice('STUDENT_CONFLICT:'.length);
      const [sectionId, member] = rest.split(':');
      return { ok: false, code: 'STUDENT_CONFLICT', sectionIds: [sectionId ?? ''], meta: { member } };
    }
    if (result.startsWith('BATCH_CONFLICT:')) {
      const rest = result.slice('BATCH_CONFLICT:'.length);
      const [a, b] = rest.split(':');
      return { ok: false, code: 'BATCH_CONFLICT', sectionIds: [a ?? '', b ?? ''] };
    }
    return { ok: false, code: 'SECTION_FULL', sectionIds: [], meta: { unexpected: result } };
  }

  async release(request: ReservationRequest): Promise<void> {
    const keys = [
      studentScheduleKey(request.termId, request.studentId),
      ...request.sections.map((section) => slotKey(request.termId, section.sectionId)),
    ];
    const payload = encodeReservationPayload(request.sections);
    await this.redis.eval(this.releaseScript, keys.length, ...keys, payload);
  }

  async syncSection(termId: string, sectionId: string, remaining: number): Promise<void> {
    await this.redis.set(slotKey(termId, sectionId), String(Math.max(0, remaining)), 'EX', SLOT_TTL_SECONDS);
  }
}

/**
 * Degraded-mode gate: no admission control beyond the database transaction
 * (which still guarantees INV-1 because rows are locked FOR UPDATE and
 * contradictory writes are impossible). Used only when REDIS_REQUIRED=false
 * and Redis is unreachable.
 */
export class DatabaseCapacityGate implements CapacityGate {
  readonly kind = 'database' as const;

  constructor(private readonly prisma: PrismaClient) {}

  async ensureInitialized(): Promise<void> {
    // nothing to do
  }

  async tryReserve(request: ReservationRequest): Promise<ReservationOutcome> {
    const sections = await this.prisma.section.findMany({
      where: { id: { in: request.sections.map((section) => section.sectionId) } },
      select: { id: true, maxCapacity: true, enrolledCount: true },
    });
    for (const section of sections) {
      if (section.enrolledCount >= section.maxCapacity) {
        return { ok: false, code: 'SECTION_FULL', sectionIds: [section.id] };
      }
    }
    return { ok: true };
  }

  async release(): Promise<void> {
    // nothing to undo
  }

  async syncSection(): Promise<void> {
    // no counters to sync
  }
}
