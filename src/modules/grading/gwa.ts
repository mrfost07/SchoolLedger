import { Decimal } from 'decimal.js';

/** Fixed-point configuration: all academic arithmetic is decimal (BSL-306). */
export const ACADEMIC_DECIMAL = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP,
});

export const GWA_SCALE = 4; // stored/compared at 4 decimal places per BSL-306

export interface TransmutationBand {
  minPercent: number;
  maxPercent: number;
  point: string;
}

/** Institutional transmutation table (BSL-309). Percent is inclusive on both ends. */
export const TRANSMUTATION: TransmutationBand[] = [
  { minPercent: 96, maxPercent: 100, point: '1.00' },
  { minPercent: 93, maxPercent: 95, point: '1.25' },
  { minPercent: 90, maxPercent: 92, point: '1.50' },
  { minPercent: 87, maxPercent: 89, point: '1.75' },
  { minPercent: 84, maxPercent: 86, point: '2.00' },
  { minPercent: 81, maxPercent: 83, point: '2.25' },
  { minPercent: 78, maxPercent: 80, point: '2.50' },
  { minPercent: 75, maxPercent: 77, point: '2.75' },
  { minPercent: 72, maxPercent: 74, point: '3.00' },
  { minPercent: 69, maxPercent: 71, point: '3.25' },
  { minPercent: 66, maxPercent: 68, point: '3.50' },
  { minPercent: 63, maxPercent: 65, point: '3.75' },
  { minPercent: 60, maxPercent: 62, point: '4.00' },
  { minPercent: 57, maxPercent: 59, point: '4.50' },
  { minPercent: 0, maxPercent: 56, point: '5.00' },
];

export function transmutePercent(percent: number | string): string {
  const value = new ACADEMIC_DECIMAL(percent);
  if (value.lessThan(0) || value.greaterThan(100)) {
    throw new RangeError(`Percentage out of range: ${percent}`);
  }
  const band = TRANSMUTATION.find(
    (candidate) => value.greaterThanOrEqualTo(candidate.minPercent) && value.lessThanOrEqualTo(candidate.maxPercent),
  );
  if (!band) throw new RangeError(`No transmutation band for ${percent}`);
  return band.point;
}

export interface WeightedGradeInput {
  /** Numeric grade as string (e.g. "1.75"); null for INC/DRP entries. */
  value: string | null;
  isInc: boolean;
  units: number;
}

export interface GwaComputation {
  weightedSum: Decimal;
  totalUnits: number;
  countedEntries: number;
  gwa: Decimal | null;
}

/**
 * Term/cumulative GWA (BSL-306):
 *   GWA = Σ(value × units) / Σ(units)
 * over POSTED, non-superseded numeric marks only (INC and DRP excluded).
 * Result is rounded HALF_UP to 4 dp; comparisons against thresholds are exact.
 */
export function computeGwa(entries: WeightedGradeInput[]): GwaComputation {
  let weightedSum = new ACADEMIC_DECIMAL(0);
  let totalUnits = 0;
  let countedEntries = 0;

  for (const entry of entries) {
    if (entry.isInc || entry.value === null) continue;
    const units = new ACADEMIC_DECIMAL(entry.units);
    if (units.lessThanOrEqualTo(0)) continue;
    weightedSum = weightedSum.plus(new ACADEMIC_DECIMAL(entry.value).times(units));
    totalUnits += entry.units;
    countedEntries += 1;
  }

  if (totalUnits === 0) {
    return { weightedSum, totalUnits, countedEntries, gwa: null };
  }
  const gwa = weightedSum.dividedBy(totalUnits).toDecimalPlaces(GWA_SCALE, Decimal.ROUND_HALF_UP);
  return { weightedSum, totalUnits, countedEntries, gwa };
}

export type AcademicStanding = 'DEANS_LISTER' | 'GOOD_STANDING' | 'PROBATION' | 'DISQUALIFIED';
export type LatinHonor = 'SUMMA_CUM_LAUDE' | 'MAGNA_CUM_LAUDE' | 'CUM_LAUDE' | null;

export interface StandingConfig {
  deansListerMaxGwa: string;
  deansListerMinUnits: number;
  deansListerMaxMark: string;
  probationMaxGwa: string;
  passingGradeMax: string;
  disqualificationStreak: number;
}

export const DEFAULT_STANDING_CONFIG: StandingConfig = {
  deansListerMaxGwa: '1.45',
  deansListerMinUnits: 15,
  deansListerMaxMark: '2.00',
  probationMaxGwa: '3.00',
  passingGradeMax: '3.00',
  disqualificationStreak: 2,
};

export interface StandingInput {
  termGwa: Decimal | null;
  cumulativeGwa: Decimal | null;
  termUnits: number;
  termMarks: string[];
  hasInc: boolean;
  probationStreak: number;
}

export function computeStanding(input: StandingInput, config: StandingConfig = DEFAULT_STANDING_CONFIG): AcademicStanding {
  const hasFailures = input.termMarks.some((mark) => new ACADEMIC_DECIMAL(mark).greaterThan(new ACADEMIC_DECIMAL(config.passingGradeMax)));
  const outstandingFailures = hasFailures;

  if (input.cumulativeGwa !== null && input.cumulativeGwa.greaterThan(new ACADEMIC_DECIMAL(config.probationMaxGwa))) {
    return input.probationStreak + 1 >= config.disqualificationStreak ? 'DISQUALIFIED' : 'PROBATION';
  }
  if (outstandingFailures) {
    return input.probationStreak + 1 >= config.disqualificationStreak ? 'DISQUALIFIED' : 'PROBATION';
  }

  if (
    input.termGwa !== null &&
    input.termGwa.lessThanOrEqualTo(new ACADEMIC_DECIMAL(config.deansListerMaxGwa)) &&
    input.termUnits >= config.deansListerMinUnits &&
    !input.hasInc &&
    input.termMarks.every((mark) => new ACADEMIC_DECIMAL(mark).lessThanOrEqualTo(new ACADEMIC_DECIMAL(config.deansListerMaxMark)))
  ) {
    return 'DEANS_LISTER';
  }

  return 'GOOD_STANDING';
}

export interface HonorsConfig {
  summaMax: string;
  magnaMax: string;
  cumLaudeMax: string;
  minMark: string;
  minResidencyRatio: number;
}

export const DEFAULT_HONORS_CONFIG: HonorsConfig = {
  summaMax: '1.20',
  magnaMax: '1.45',
  cumLaudeMax: '1.75',
  minMark: '2.50',
  minResidencyRatio: 0.75,
};

/** Latin honors eligibility on the final cumulative GWA (BSL-308). */
export function latinHonors(
  cumulativeGwa: Decimal | null,
  allMarks: string[],
  residencyRatio: number,
  config: HonorsConfig = DEFAULT_HONORS_CONFIG,
): LatinHonor {
  if (cumulativeGwa === null) return null;
  if (residencyRatio < config.minResidencyRatio) return null;
  if (allMarks.some((mark) => new ACADEMIC_DECIMAL(mark).greaterThan(new ACADEMIC_DECIMAL(config.minMark)))) return null;

  if (cumulativeGwa.lessThanOrEqualTo(new ACADEMIC_DECIMAL(config.summaMax))) return 'SUMMA_CUM_LAUDE';
  if (cumulativeGwa.lessThanOrEqualTo(new ACADEMIC_DECIMAL(config.magnaMax))) return 'MAGNA_CUM_LAUDE';
  if (cumulativeGwa.lessThanOrEqualTo(new ACADEMIC_DECIMAL(config.cumLaudeMax))) return 'CUM_LAUDE';
  return null;
}
