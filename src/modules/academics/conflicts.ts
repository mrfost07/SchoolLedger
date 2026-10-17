import { AppError, ErrorCodes } from '../../core/errors/taxonomy';

export interface Interval {
  dayOfWeek: number; // 1 = Monday … 7 = Sunday
  startMin: number; // minutes from midnight, inclusive
  endMin: number; // minutes from midnight, exclusive
}

export interface ScheduleOwner {
  scheduleId?: string;
  sectionId: string;
  sectionCode?: string;
  roomId: string;
  instructorId: string;
  interval: Interval;
}

export type ConflictCode = 'CONFLICT_ROOM' | 'CONFLICT_INSTRUCTOR' | 'CONFLICT_STUDENT_SCHEDULE';

export interface ConflictDiagnostic {
  code: ConflictCode;
  dayOfWeek: number;
  requested: Interval & { roomId: string; instructorId: string };
  existing: {
    sectionId: string;
    sectionCode?: string;
    scheduleId?: string;
    roomId: string;
    instructorId: string;
    interval: Interval;
  };
  message: string;
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.dayOfWeek === b.dayOfWeek && a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * Service-layer conflict detector (BSL-104 layer 2).
 * Returns structured diagnostics; the DB GiST exclusion constraints are the
 * final authority (layer 1) and still protect against races.
 */
export function findScheduleConflicts(requested: ScheduleOwner, existing: ScheduleOwner[]): ConflictDiagnostic[] {
  const conflicts: ConflictDiagnostic[] = [];
  for (const other of existing) {
    if (other.scheduleId && requested.scheduleId && other.scheduleId === requested.scheduleId) continue;
    if (!intervalsOverlap(requested.interval, other.interval)) continue;

    if (other.roomId === requested.roomId) {
      conflicts.push({
        code: 'CONFLICT_ROOM',
        dayOfWeek: requested.interval.dayOfWeek,
        requested: { ...requested.interval, roomId: requested.roomId, instructorId: requested.instructorId },
        existing: {
          sectionId: other.sectionId,
          sectionCode: other.sectionCode,
          scheduleId: other.scheduleId,
          roomId: other.roomId,
          instructorId: other.instructorId,
          interval: other.interval,
        },
        message: `Room is already booked by section ${other.sectionCode ?? other.sectionId} on day ${other.interval.dayOfWeek} ${formatMinutes(other.interval.startMin)}–${formatMinutes(other.interval.endMin)}.`,
      });
    }
    if (other.instructorId === requested.instructorId) {
      conflicts.push({
        code: 'CONFLICT_INSTRUCTOR',
        dayOfWeek: requested.interval.dayOfWeek,
        requested: { ...requested.interval, roomId: requested.roomId, instructorId: requested.instructorId },
        existing: {
          sectionId: other.sectionId,
          sectionCode: other.sectionCode,
          scheduleId: other.scheduleId,
          roomId: other.roomId,
          instructorId: other.instructorId,
          interval: other.interval,
        },
        message: `Instructor is already teaching section ${other.sectionCode ?? other.sectionId} on day ${other.interval.dayOfWeek} ${formatMinutes(other.interval.startMin)}–${formatMinutes(other.interval.endMin)}.`,
      });
    }
  }
  return conflicts;
}

export function summarizeStudentConflicts(
  requestedSectionId: string,
  requestedSectionCode: string | undefined,
  requestedIntervals: Interval[],
  existingSections: Array<{ sectionId: string; sectionCode?: string; intervals: Interval[] }>,
): ConflictDiagnostic[] {
  const conflicts: ConflictDiagnostic[] = [];
  for (const existing of existingSections) {
    if (existing.sectionId === requestedSectionId) continue;
    for (const requestedInterval of requestedIntervals) {
      for (const existingInterval of existing.intervals) {
        if (!intervalsOverlap(requestedInterval, existingInterval)) continue;
        conflicts.push({
          code: 'CONFLICT_STUDENT_SCHEDULE',
          dayOfWeek: requestedInterval.dayOfWeek,
          requested: {
            ...requestedInterval,
            roomId: '',
            instructorId: '',
          },
          existing: {
            sectionId: existing.sectionId,
            sectionCode: existing.sectionCode,
            roomId: '',
            instructorId: '',
            interval: existingInterval,
          },
          message: `Requested section ${requestedSectionCode ?? requestedSectionId} overlaps with enrolled section ${existing.sectionCode ?? existing.sectionId} on day ${requestedInterval.dayOfWeek} ${formatMinutes(requestedInterval.startMin)}–${formatMinutes(requestedInterval.endMin)}.`,
        });
      }
    }
  }
  return conflicts;
}

export function throwOnScheduleConflicts(conflicts: ConflictDiagnostic[]): void {
  if (conflicts.length === 0) return;
  throw new AppError(ErrorCodes.SCHEDULE_CONFLICT, conflicts[0]!.message, {
    meta: { conflicts },
  });
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
