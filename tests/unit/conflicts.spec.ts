import { describe, expect, it } from 'vitest';
import {
  findScheduleConflicts,
  intervalsOverlap,
  summarizeStudentConflicts,
  throwOnScheduleConflicts,
  type ScheduleOwner,
} from '../../src/modules/academics/conflicts';
import { AppError, ErrorCodes } from '../../src/core/errors/taxonomy';

const owner = (overrides: Partial<ScheduleOwner>): ScheduleOwner => ({
  sectionId: 's1',
  sectionCode: 'SEC-A',
  roomId: 'room-1',
  instructorId: 'inst-1',
  interval: { dayOfWeek: 1, startMin: 480, endMin: 540 },
  ...overrides,
});

describe('schedule conflict detection', () => {
  it('overlap semantics are half-open intervals', () => {
    expect(intervalsOverlap({ dayOfWeek: 1, startMin: 480, endMin: 540 }, { dayOfWeek: 1, startMin: 540, endMin: 600 })).toBe(false);
    expect(intervalsOverlap({ dayOfWeek: 1, startMin: 480, endMin: 541 }, { dayOfWeek: 1, startMin: 540, endMin: 600 })).toBe(true);
    expect(intervalsOverlap({ dayOfWeek: 2, startMin: 480, endMin: 540 }, { dayOfWeek: 1, startMin: 480, endMin: 540 })).toBe(false);
  });

  it('flags room and instructor conflicts on the same slot', () => {
    const conflicts = findScheduleConflicts(owner({ sectionId: 's2' }), [owner({})]);
    expect(conflicts.map((c) => c.code).sort()).toEqual(['CONFLICT_INSTRUCTOR', 'CONFLICT_ROOM']);
  });

  it('flags only the instructor when rooms differ', () => {
    const conflicts = findScheduleConflicts(owner({ sectionId: 's2', roomId: 'room-2' }), [owner({})]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.code).toBe('CONFLICT_INSTRUCTOR');
  });

  it('ignores the slot being edited (same scheduleId)', () => {
    const conflicts = findScheduleConflicts(owner({ scheduleId: 'sch-1' }), [owner({ scheduleId: 'sch-1' })]);
    expect(conflicts).toHaveLength(0);
  });

  it('detects student schedule overlaps across sections', () => {
    const conflicts = summarizeStudentConflicts(
      'new-section',
      'CS102-B',
      [{ dayOfWeek: 3, startMin: 600, endMin: 660 }],
      [{ sectionId: 'old-section', sectionCode: 'GE101-A', intervals: [{ dayOfWeek: 3, startMin: 630, endMin: 690 }] }],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.code).toBe('CONFLICT_STUDENT_SCHEDULE');
    expect(conflicts[0]!.existing.sectionCode).toBe('GE101-A');
  });

  it('throwOnScheduleConflicts raises SCHEDULE_CONFLICT with diagnostics', () => {
    expect(() => throwOnScheduleConflicts([])).not.toThrow();
    try {
      throwOnScheduleConflicts(findScheduleConflicts(owner({ sectionId: 's2' }), [owner({})]));
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.SCHEDULE_CONFLICT);
      expect(Array.isArray((error as AppError).meta.conflicts)).toBe(true);
    }
  });
});
