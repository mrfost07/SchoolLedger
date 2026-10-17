import { sha256Hex } from '../../core/crypto/hash';

export interface GradeHashInput {
  prevHash: string | null;
  studentId: string;
  courseId: string;
  termId: string;
  sectionId: string;
  mark: string;
  version: number;
  timestampIso: string;
}

/**
 * Grade ledger entry hash (BSL-302):
 * sha256(prev_hash ‖ student ‖ course ‖ term ‖ section ‖ mark ‖ version ‖ ISO(ts))
 * `prev_hash` chains every version of the same (student, course) record so
 * rectifications and INC conversions are cryptographically linked.
 */
export function gradeEntryHash(input: GradeHashInput): string {
  return sha256Hex(
    [
      input.prevHash ?? '',
      input.studentId,
      input.courseId,
      input.termId,
      input.sectionId,
      input.mark,
      String(input.version),
      input.timestampIso,
    ].join('|'),
  );
}

export function markToString(mark: { kind: 'NUMERIC'; value: string } | { kind: 'INC' } | { kind: 'DRP' }): string {
  if (mark.kind === 'NUMERIC') {
    const numeric = Number.parseFloat(mark.value);
    return numeric.toFixed(2);
  }
  return mark.kind;
}
