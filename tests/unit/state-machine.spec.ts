import { describe, expect, it } from 'vitest';
import {
  assertEntryTransition,
  assertSheetTransition,
  canTransitionSheet,
  markFromEntry,
  validateMark,
} from '../../src/modules/grading/state-machine';
import { gradeEntryHash, markToString } from '../../src/modules/grading/ledger-hash';
import { AppError, ErrorCodes } from '../../src/core/errors/taxonomy';

describe('grade sheet state machine (BSL-302)', () => {
  it('allows the happy path and the return path', () => {
    expect(canTransitionSheet('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransitionSheet('SUBMITTED', 'VERIFIED')).toBe(true);
    expect(canTransitionSheet('VERIFIED', 'POSTED')).toBe(true);
    expect(canTransitionSheet('SUBMITTED', 'DRAFT')).toBe(true);
    expect(canTransitionSheet('VERIFIED', 'DRAFT')).toBe(true);
  });

  it('POSTED is terminal', () => {
    expect(canTransitionSheet('POSTED', 'DRAFT')).toBe(false);
    expect(canTransitionSheet('POSTED', 'SUBMITTED')).toBe(false);
    expect(() => assertSheetTransition('POSTED', 'DRAFT')).toThrowError(AppError);
  });

  it('skipping steps is rejected', () => {
    expect(() => assertSheetTransition('DRAFT', 'POSTED')).toThrowError(/Illegal grade sheet transition/);
    expect(() => assertSheetTransition('DRAFT', 'VERIFIED')).toThrowError(/Illegal grade sheet transition/);
  });

  it('entries may only be superseded once posted', () => {
    expect(() => assertEntryTransition('POSTED', 'SUPERSEDED')).not.toThrow();
    expect(() => assertEntryTransition('SUPERSEDED', 'POSTED')).toThrow();
    expect(() => assertEntryTransition('VERIFIED', 'SUPERSEDED')).toThrow();
  });
});

describe('mark validation', () => {
  it('accepts the 1.00–5.00 range with up to 2 decimals', () => {
    expect(() => validateMark({ kind: 'NUMERIC', value: '1.00' })).not.toThrow();
    expect(() => validateMark({ kind: 'NUMERIC', value: '5' })).not.toThrow();
    expect(() => validateMark({ kind: 'NUMERIC', value: '3.25' })).not.toThrow();
    expect(() => validateMark({ kind: 'INC' })).not.toThrow();
    expect(() => validateMark({ kind: 'DRP' })).not.toThrow();
  });

  it('rejects out-of-range, malformed and over-precise marks', () => {
    for (const value of ['0.75', '5.01', 'abc', '1.234', '-2', '']) {
      try {
        validateMark({ kind: 'NUMERIC', value });
        expect.unreachable(`expected ${value} to be rejected`);
      } catch (error) {
        expect((error as AppError).code).toBe(ErrorCodes.GRADE_OUT_OF_RANGE);
      }
    }
  });

  it('normalizes entries to marks', () => {
    expect(markFromEntry({ value: '1.50', isInc: false })).toEqual({ kind: 'NUMERIC', value: '1.50' });
    expect(markFromEntry({ value: null, isInc: true })).toEqual({ kind: 'INC' });
    expect(markFromEntry({ value: null, isInc: false })).toEqual({ kind: 'DRP' });
    expect(markToString({ kind: 'NUMERIC', value: '2.5' })).toBe('2.50');
    expect(markToString({ kind: 'INC' })).toBe('INC');
  });
});

describe('grade ledger hash chain (BSL-302)', () => {
  const base = {
    prevHash: null as string | null,
    studentId: 'student-1',
    courseId: 'course-1',
    termId: 'term-1',
    sectionId: 'section-1',
    mark: '1.50',
    version: 1,
    timestampIso: '2026-01-05T08:00:00.000Z',
  };

  it('is deterministic and 64-hex', () => {
    const a = gradeEntryHash(base);
    const b = gradeEntryHash({ ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any field changes (tamper evidence)', () => {
    const original = gradeEntryHash(base);
    expect(gradeEntryHash({ ...base, mark: '1.75' })).not.toBe(original);
    expect(gradeEntryHash({ ...base, version: 2 })).not.toBe(original);
    expect(gradeEntryHash({ ...base, timestampIso: '2026-01-06T08:00:00.000Z' })).not.toBe(original);
  });

  it('chains version 2 to the previous hash', () => {
    const v1 = gradeEntryHash(base);
    const v2 = gradeEntryHash({ ...base, prevHash: v1, mark: '1.75', version: 2 });
    expect(v2).not.toBe(v1);
    expect(gradeEntryHash({ ...base, prevHash: v1, mark: '1.75', version: 2 })).toBe(v2);
  });
});
