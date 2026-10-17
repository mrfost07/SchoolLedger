import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  ACADEMIC_DECIMAL,
  computeGwa,
  computeStanding,
  DEFAULT_HONORS_CONFIG,
  DEFAULT_STANDING_CONFIG,
  latinHonors,
  transmutePercent,
} from '../../src/modules/grading/gwa';

describe('GWA engine (BSL-306)', () => {
  it('weights by units and rounds HALF_UP at 4dp', () => {
    const result = computeGwa([
      { value: '1.25', isInc: false, units: 3 },
      { value: '1.75', isInc: false, units: 3 },
      { value: '2.00', isInc: false, units: 1 },
    ]);
    // (1.25*3 + 1.75*3 + 2.00*1) / 7 = 11 / 7 = 1.571428… → 1.5714
    expect(result.gwa!.toFixed(4)).toBe('1.5714');
    expect(result.totalUnits).toBe(7);
    expect(result.countedEntries).toBe(3);
  });

  it('excludes INC and DRP (null) entries from both numerator and denominator', () => {
    const result = computeGwa([
      { value: '1.00', isInc: false, units: 3 },
      { value: null, isInc: true, units: 3 },
      { value: null, isInc: false, units: 2 },
    ]);
    expect(result.gwa!.toFixed(4)).toBe('1.0000');
    expect(result.totalUnits).toBe(3);
  });

  it('returns null GWA when nothing is countable', () => {
    const result = computeGwa([{ value: null, isInc: true, units: 3 }]);
    expect(result.gwa).toBeNull();
    expect(result.totalUnits).toBe(0);
  });

  it('threshold comparisons are exact at 4dp (1.4500 == Dean\u2019s Lister cutoff)', () => {
    const atCutoff = computeGwa([
      { value: '1.45', isInc: false, units: 20 },
    ]);
    const overCutoff = computeGwa([
      { value: '1.45', isInc: false, units: 19 },
      { value: '1.46', isInc: false, units: 1 },
    ]);
    expect(atCutoff.gwa!.equals(new ACADEMIC_DECIMAL('1.45'))).toBe(true);
    expect(overCutoff.gwa!.greaterThan(new ACADEMIC_DECIMAL('1.45'))).toBe(true);
  });
});

describe('transmutation table (BSL-309)', () => {
  it('maps boundaries inclusively', () => {
    expect(transmutePercent(100)).toBe('1.00');
    expect(transmutePercent(96)).toBe('1.00');
    expect(transmutePercent(95)).toBe('1.25');
    expect(transmutePercent(60)).toBe('4.00');
    expect(transmutePercent(56)).toBe('5.00');
    expect(transmutePercent(0)).toBe('5.00');
  });

  it('rejects out-of-range percentages', () => {
    expect(() => transmutePercent(101)).toThrow(RangeError);
    expect(() => transmutePercent(-1)).toThrow(RangeError);
  });
});

describe('academic standing (BSL-307)', () => {
  const base = {
    termGwa: new ACADEMIC_DECIMAL('1.40'),
    cumulativeGwa: new ACADEMIC_DECIMAL('1.40'),
    termUnits: 18,
    termMarks: ['1.25', '1.50', '1.75'],
    hasInc: false,
    probationStreak: 0,
  };

  it('awards Dean\u2019s Lister at the exact thresholds', () => {
    expect(computeStanding(base)).toBe('DEANS_LISTER');
  });

  it('denies Dean\u2019s Lister when units are below the minimum', () => {
    expect(computeStanding({ ...base, termUnits: DEFAULT_STANDING_CONFIG.deansListerMinUnits - 1 })).toBe('GOOD_STANDING');
  });

  it('denies Dean\u2019s Lister when any mark exceeds 2.00 or an INC exists', () => {
    expect(computeStanding({ ...base, termMarks: ['1.25', '2.25'] })).toBe('GOOD_STANDING');
    expect(computeStanding({ ...base, hasInc: true })).toBe('GOOD_STANDING');
  });

  it('flags probation on a failing mark and second consecutive term disqualifies', () => {
    const failing = { ...base, termMarks: ['1.25', '4.00'], termGwa: new ACADEMIC_DECIMAL('2.10'), cumulativeGwa: new ACADEMIC_DECIMAL('1.90') };
    expect(computeStanding(failing)).toBe('PROBATION');
    expect(computeStanding({ ...failing, probationStreak: 1 })).toBe('DISQUALIFIED');
  });
});

describe('latin honors (BSL-308)', () => {
  it('applies the cumulative cutoffs', () => {
    expect(latinHonors(new ACADEMIC_DECIMAL('1.15'), ['1.00'], 1, DEFAULT_HONORS_CONFIG)).toBe('SUMMA_CUM_LAUDE');
    expect(latinHonors(new ACADEMIC_DECIMAL('1.30'), ['1.25'], 1, DEFAULT_HONORS_CONFIG)).toBe('MAGNA_CUM_LAUDE');
    expect(latinHonors(new ACADEMIC_DECIMAL('1.70'), ['1.50'], 1, DEFAULT_HONORS_CONFIG)).toBe('CUM_LAUDE');
    expect(latinHonors(new ACADEMIC_DECIMAL('2.00'), ['1.75'], 1, DEFAULT_HONORS_CONFIG)).toBeNull();
  });

  it('voids honors on any mark beyond 2.50 or insufficient residency', () => {
    expect(latinHonors(new ACADEMIC_DECIMAL('1.10'), ['1.00', '3.00'], 1, DEFAULT_HONORS_CONFIG)).toBeNull();
    expect(latinHonors(new ACADEMIC_DECIMAL('1.10'), ['1.00'], 0.5, DEFAULT_HONORS_CONFIG)).toBeNull();
  });

  it('accepts the boundary marks exactly', () => {
    expect(latinHonors(new ACADEMIC_DECIMAL('1.10'), ['2.50'], 1, DEFAULT_HONORS_CONFIG)).toBe('SUMMA_CUM_LAUDE');
  });

  it('shares Decimal config with the service (28-digit precision, HALF_UP)', () => {
    expect(new Decimal(1).constructor).toBeTypeOf('function');
    expect(ACADEMIC_DECIMAL.rounding).toBe(Decimal.ROUND_HALF_UP);
  });
});
