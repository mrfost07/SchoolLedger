import { AppError, ErrorCodes } from '../../core/errors/taxonomy';

export type SheetStatus = 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'POSTED';
export type EntryStatus = 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'POSTED' | 'SUPERSEDED';

/**
 * Grade sheet state machine (BSL-302):
 *
 *   DRAFT ──submit(Instructor+MFA)──▶ SUBMITTED ──verify(Chair)──▶ VERIFIED
 *     ▲                                   │                            │
 *     └────────return (rework)────────────┴────────return──────────────┤
 *                                                                      ▼
 *                                              POSTED ◀──post(Registrar+MFA)
 *
 * POSTED is terminal for the sheet; changes flow through GradeRectification
 * and produce a new ledger entry (version+1), never an in-place mutation.
 */
export const SHEET_TRANSITIONS: Record<SheetStatus, SheetStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['VERIFIED', 'DRAFT'],
  VERIFIED: ['POSTED', 'DRAFT'],
  POSTED: [],
};

export const ENTRY_TRANSITIONS: Record<EntryStatus, EntryStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['VERIFIED', 'DRAFT'],
  VERIFIED: ['POSTED', 'DRAFT'],
  POSTED: ['SUPERSEDED'],
  SUPERSEDED: [],
};

export function canTransitionSheet(from: SheetStatus, to: SheetStatus): boolean {
  return SHEET_TRANSITIONS[from].includes(to);
}

export function assertSheetTransition(from: SheetStatus, to: SheetStatus): void {
  if (!canTransitionSheet(from, to)) {
    throw new AppError(ErrorCodes.GRADE_STATE_INVALID, `Illegal grade sheet transition ${from} → ${to}.`, {
      meta: { from, to, allowed: SHEET_TRANSITIONS[from] },
    });
  }
}

export function assertEntryTransition(from: EntryStatus, to: EntryStatus): void {
  if (!ENTRY_TRANSITIONS[from].includes(to)) {
    throw new AppError(ErrorCodes.GRADE_STATE_INVALID, `Illegal grade entry transition ${from} → ${to}.`, {
      meta: { from, to, allowed: ENTRY_TRANSITIONS[from] },
    });
  }
}

export type Mark =
  | { kind: 'NUMERIC'; value: string }
  | { kind: 'INC' }
  | { kind: 'DRP' };

export interface MarkValidationOptions {
  min?: string;
  max?: string;
}

/** Validates a grade mark; numeric marks must be ≤ 2 decimal places in [1.00, 5.00]. */
export function validateMark(mark: Mark, options: MarkValidationOptions = {}): void {
  if (mark.kind === 'INC' || mark.kind === 'DRP') return;
  const value = Number.parseFloat(mark.value);
  const min = Number.parseFloat(options.min ?? '1.00');
  const max = Number.parseFloat(options.max ?? '5.00');
  if (!Number.isFinite(value) || !/^\d+(\.\d{1,2})?$/.test(mark.value)) {
    throw new AppError(ErrorCodes.GRADE_OUT_OF_RANGE, `Invalid numeric grade "${mark.value}".`, { meta: { mark } });
  }
  if (value < min || value > max) {
    throw new AppError(ErrorCodes.GRADE_OUT_OF_RANGE, `Numeric grade must be within [${min}, ${max}].`, { meta: { mark } });
  }
}

export function markFromEntry(entry: { value: unknown; isInc: boolean }): Mark {
  if (entry.isInc) return { kind: 'INC' };
  if (entry.value === null || entry.value === undefined) return { kind: 'DRP' };
  return { kind: 'NUMERIC', value: String(entry.value) };
}
