import { Decimal } from 'decimal.js';
import type { GradeEntryStatus, GradeLedgerEntry, GradeSheet, PrismaClient } from '@prisma/client';
import type { Env } from '../../config/env';
import type { Clock } from '../../core/time/clock';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { addDays } from '../../core/time/clock';
import type { AuditService } from '../audit/audit.service';
import type { SectionAccessService } from '../academics/guards';
import { assertEntryTransition, assertSheetTransition, markFromEntry, validateMark, type Mark } from './state-machine';
import { gradeEntryHash, markToString } from './ledger-hash';
import {
  ACADEMIC_DECIMAL,
  computeGwa,
  computeStanding,
  latinHonors,
  GWA_SCALE,
  type AcademicStanding,
  type LatinHonor,
} from './gwa';

export interface GradeEntryInput {
  studentId: string;
  mark: Mark;
}

export interface StudentGwaReport {
  studentId: string;
  terms: Array<{
    termId: string;
    termCode: string;
    gwa: string | null;
    units: number;
    entries: number;
    incCount: number;
  }>;
  cumulativeGwa: string | null;
  totalUnits: number;
  standing: AcademicStanding;
  latinHonors: LatinHonor;
}

export class GradingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly sectionAccess: SectionAccessService,
    private readonly clock: Clock,
    private readonly config: Pick<
      Env,
      | 'incCompletionDays'
      | 'incDefaultGrade'
      | 'deansListerMaxGwa'
      | 'honorsSummaMax'
      | 'honorsMagnaMax'
      | 'honorsCumLaudeMax'
    >,
  ) {}

  // ── Sheet lifecycle (BSL-302) ──────────────────────────────────────────────

  async upsertDraftEntries(actorId: string, sectionId: string, entries: GradeEntryInput[]): Promise<GradeSheet & { entries: GradeLedgerEntry[] }> {
    const section = await this.sectionAccess.assertInstructorCanGrade(actorId, sectionId);

    const enrolledItems = await this.prisma.enrollmentItem.findMany({
      where: { sectionId, status: 'ENROLLED' },
      select: { enrollment: { select: { studentId: true } } },
    });
    const enrolledStudentIds = new Set(enrolledItems.map((item) => item.enrollment.studentId));
    for (const entry of entries) {
      if (!enrolledStudentIds.has(entry.studentId)) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, `Student ${entry.studentId} is not actively enrolled in this section.`);
      }
      validateMark(entry.mark);
    }

    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      let sheet = await tx.gradeSheet.findUnique({ where: { sectionId } });
      if (!sheet) {
        sheet = await tx.gradeSheet.create({
          data: { sectionId, termId: section.termId, status: 'DRAFT' },
        });
      }
      if (sheet.status !== 'DRAFT') {
        throw new AppError(
          ErrorCodes.GRADE_STATE_INVALID,
          `Grade sheet is ${sheet.status}; only DRAFT sheets can be edited (use the rectification workflow for POSTED sheets).`,
        );
      }

      for (const entry of entries) {
        const existing = await tx.gradeLedgerEntry.findFirst({ where: { sheetId: sheet.id, studentId: entry.studentId } });
        const data = {
          value: entry.mark.kind === 'NUMERIC' ? new Decimal(entry.mark.value).toFixed(2) : null,
          isInc: entry.mark.kind === 'INC',
        };
        if (existing) {
          await tx.gradeLedgerEntry.update({ where: { id: existing.id }, data });
        } else {
          await tx.gradeLedgerEntry.create({
            data: {
              studentId: entry.studentId,
              courseId: section.courseId,
              termId: section.termId,
              sectionId,
              sheetId: sheet.id,
              status: 'DRAFT',
              version: 1,
              value: data.value,
              isInc: data.isInc,
            },
          });
        }
      }

      await this.audit.append(tx, {
        actorId,
        action: 'grading.entries.saved',
        resourceType: 'grade_sheet',
        resourceId: sheet.id,
        payload: { sectionId, entries: entries.length },
      });

      const full = await tx.gradeSheet.findUniqueOrThrow({ where: { id: sheet.id }, include: { entries: true } });
      return full;
    });
  }

  async submitSheet(actorId: string, sectionId: string): Promise<GradeSheet> {
    const section = await this.sectionAccess.assertInstructorCanGrade(actorId, sectionId);
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const sheet = await tx.gradeSheet.findUnique({ where: { sectionId }, include: { entries: true } });
      if (!sheet) throw new AppError(ErrorCodes.GRADE_SHEET_NOT_FOUND, 'No grade sheet exists for this section.');
      assertSheetTransition(sheet.status as 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'POSTED', 'SUBMITTED');
      if (sheet.entries.length === 0) {
        throw new AppError(ErrorCodes.GRADE_STATE_INVALID, 'Cannot submit an empty grade sheet.');
      }

      const enrolled = await tx.enrollmentItem.count({ where: { sectionId, status: 'ENROLLED' } });
      if (sheet.entries.length !== enrolled) {
        throw new AppError(
          ErrorCodes.GRADE_STATE_INVALID,
          `Every actively enrolled student needs a grade entry (sheet: ${sheet.entries.length}, enrolled: ${enrolled}).`,
        );
      }

      for (const entry of sheet.entries) {
        assertEntryTransition(entry.status as GradeEntryStatus, 'SUBMITTED');
      }

      await tx.gradeLedgerEntry.updateMany({ where: { sheetId: sheet.id, status: 'DRAFT' }, data: { status: 'SUBMITTED' } });
      const updated = await tx.gradeSheet.update({
        where: { id: sheet.id },
        data: { status: 'SUBMITTED', submittedById: actorId, submittedAt: now },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.sheet.submitted',
        resourceType: 'grade_sheet',
        resourceId: sheet.id,
        payload: { sectionId, termId: section.termId, entries: sheet.entries.length },
      });
      return updated;
    });
  }

  async verifySheet(actorId: string, sectionId: string): Promise<GradeSheet> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const sheet = await tx.gradeSheet.findUnique({ where: { sectionId } });
      if (!sheet) throw new AppError(ErrorCodes.GRADE_SHEET_NOT_FOUND, 'No grade sheet exists for this section.');
      assertSheetTransition(sheet.status as 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'POSTED', 'VERIFIED');

      await tx.gradeLedgerEntry.updateMany({ where: { sheetId: sheet.id, status: 'SUBMITTED' }, data: { status: 'VERIFIED' } });
      const updated = await tx.gradeSheet.update({
        where: { id: sheet.id },
        data: { status: 'VERIFIED', verifiedById: actorId, verifiedAt: now },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.sheet.verified',
        resourceType: 'grade_sheet',
        resourceId: sheet.id,
        payload: { sectionId },
      });
      return updated;
    });
  }

  async returnSheet(actorId: string, sectionId: string, note: string): Promise<GradeSheet> {
    return this.prisma.$transaction(async (tx) => {
      const sheet = await tx.gradeSheet.findUnique({ where: { sectionId } });
      if (!sheet) throw new AppError(ErrorCodes.GRADE_SHEET_NOT_FOUND, 'No grade sheet exists for this section.');
      assertSheetTransition(sheet.status as 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'POSTED', 'DRAFT');

      await tx.gradeLedgerEntry.updateMany({
        where: { sheetId: sheet.id, status: { in: ['SUBMITTED', 'VERIFIED'] } },
        data: { status: 'DRAFT' },
      });
      const updated = await tx.gradeSheet.update({
        where: { id: sheet.id },
        data: { status: 'DRAFT', submittedById: null, submittedAt: null, verifiedById: null, verifiedAt: null },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.sheet.returned',
        resourceType: 'grade_sheet',
        resourceId: sheet.id,
        payload: { sectionId, note },
      });
      return updated;
    });
  }

  async postSheet(actorId: string, sectionId: string): Promise<GradeSheet> {
    const now = this.clock.now();
    const postedAtIso = now.toISOString();

    return this.prisma.$transaction(async (tx) => {
      const sheet = await tx.gradeSheet.findUnique({ where: { sectionId }, include: { entries: true } });
      if (!sheet) throw new AppError(ErrorCodes.GRADE_SHEET_NOT_FOUND, 'No grade sheet exists for this section.');
      assertSheetTransition(sheet.status as 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'POSTED', 'POSTED');

      for (const entry of sheet.entries) {
        assertEntryTransition(entry.status as GradeEntryStatus, 'POSTED');

        const previous = await tx.gradeLedgerEntry.findFirst({
          where: { studentId: entry.studentId, courseId: entry.courseId },
          orderBy: { version: 'desc' },
        });
        const prevHash = previous?.entryHash ?? null;
        const mark = markToString(markFromEntry(entry));
        const entryHash = gradeEntryHash({
          prevHash,
          studentId: entry.studentId,
          courseId: entry.courseId,
          termId: entry.termId,
          sectionId: entry.sectionId,
          mark,
          version: entry.version,
          timestampIso: postedAtIso,
        });

        await tx.gradeLedgerEntry.update({
          where: { id: entry.id },
          data: {
            status: 'POSTED',
            prevHash,
            entryHash,
            incDeadlineAt: entry.isInc ? addDays(now, this.config.incCompletionDays) : null,
          },
        });
      }

      const updated = await tx.gradeSheet.update({
        where: { id: sheet.id },
        data: { status: 'POSTED', postedById: actorId, postedAt: now },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.sheet.posted',
        resourceType: 'grade_sheet',
        resourceId: sheet.id,
        payload: { sectionId, termId: sheet.termId, entries: sheet.entries.length, postedAt: postedAtIso },
      });
      return updated;
    });
  }

  async getSheet(sectionId: string) {
    const sheet = await this.prisma.gradeSheet.findUnique({
      where: { sectionId },
      include: {
        entries: {
          include: { student: { select: { id: true, firstName: true, lastName: true, email: true } } },
          orderBy: { student: { lastName: 'asc' } },
        },
        section: { include: { course: true, term: true, instructor: { select: { id: true, firstName: true, lastName: true } } } },
      },
    });
    if (!sheet) throw new AppError(ErrorCodes.GRADE_SHEET_NOT_FOUND, 'No grade sheet exists for this section.');
    return sheet;
  }

  // ── Ledger reads & GWA ─────────────────────────────────────────────────────

  private async activeEntries(studentId: string, termId?: string) {
    return this.prisma.gradeLedgerEntry.findMany({
      where: {
        studentId,
        status: 'POSTED',
        ...(termId ? { termId } : {}),
      },
      include: {
        course: { select: { id: true, code: true, title: true, lectureUnits: true, labUnits: true } },
        term: { select: { id: true, code: true } },
      },
      orderBy: [{ term: { startsAt: 'asc' } }, { course: { code: 'asc' } }],
    });
  }

  async studentLedger(studentId: string) {
    return this.prisma.gradeLedgerEntry.findMany({
      where: { studentId, status: { in: ['POSTED', 'SUPERSEDED'] } },
      include: {
        course: { select: { id: true, code: true, title: true, lectureUnits: true, labUnits: true } },
        term: { select: { id: true, code: true } },
        section: { select: { id: true, sectionCode: true } },
      },
      orderBy: [{ term: { startsAt: 'asc' } }, { course: { code: 'asc' } }, { version: 'asc' }],
    });
  }

  /** Term + cumulative GWA, academic standing and honors (BSL-306, BSL-307, BSL-308). */
  async computeStudentGwa(studentId: string): Promise<StudentGwaReport> {
    const entries = await this.activeEntries(studentId);

    const byTerm = new Map<string, { code: string; entries: typeof entries }>();
    for (const entry of entries) {
      const bucket = byTerm.get(entry.termId) ?? { code: entry.term.code, entries: [] };
      bucket.entries.push(entry);
      byTerm.set(entry.termId, bucket);
    }

    const terms: StudentGwaReport['terms'] = [];
    const orderedTermIds = [...byTerm.keys()].sort((a, b) => {
      const first = byTerm.get(a)!.entries[0]!.term.code;
      const second = byTerm.get(b)!.entries[0]!.term.code;
      return first.localeCompare(second);
    });

    for (const termId of orderedTermIds) {
      const bucket = byTerm.get(termId)!;
      const weighted = bucket.entries.map((entry) => ({
        value: entry.value ? entry.value.toString() : null,
        isInc: entry.isInc,
        units: entry.course.lectureUnits + entry.course.labUnits,
      }));
      const gwa = computeGwa(weighted);
      terms.push({
        termId,
        termCode: bucket.code,
        gwa: gwa.gwa ? gwa.gwa.toFixed(GWA_SCALE) : null,
        units: gwa.totalUnits,
        entries: gwa.countedEntries,
        incCount: bucket.entries.filter((entry) => entry.isInc).length,
      });
    }

    const cumulativeInput = entries.map((entry) => ({
      value: entry.value ? entry.value.toString() : null,
      isInc: entry.isInc,
      units: entry.course.lectureUnits + entry.course.labUnits,
    }));
    const cumulative = computeGwa(cumulativeInput);

    // Probation streak: count consecutive PRIOR terms with a failing mark
    // (> 3.00) or a term GWA > 3.00. The latest term is intentionally excluded —
    // computeStanding adds the current term itself (`probationStreak + 1`).
    let probationStreak = 0;
    for (let index = terms.length - 2; index >= 0; index -= 1) {
      const term = terms[index]!;
      const bucket = byTerm.get(term.termId)!;
      const marks = bucket.entries.filter((entry) => !entry.isInc && entry.value).map((entry) => entry.value!.toString());
      const hasFailure = marks.some((mark) => new ACADEMIC_DECIMAL(mark).greaterThan(3.0));
      const gwaOver = term.gwa !== null && new ACADEMIC_DECIMAL(term.gwa).greaterThan(3.0);
      if (hasFailure || gwaOver) probationStreak += 1;
      else break;
    }

    const latestTerm = terms[terms.length - 1];
    const latestBucket = latestTerm ? byTerm.get(latestTerm.termId)! : null;
    const latestMarks = latestBucket
      ? latestBucket.entries.filter((entry) => !entry.isInc && entry.value).map((entry) => entry.value!.toString())
      : [];

    const standing = computeStanding({
      termGwa: latestTerm?.gwa ? new ACADEMIC_DECIMAL(latestTerm.gwa) : null,
      cumulativeGwa: cumulative.gwa,
      termUnits: latestTerm?.units ?? 0,
      termMarks: latestMarks,
      hasInc: (latestTerm?.incCount ?? 0) > 0,
      probationStreak,
    });

    const allMarks = entries.filter((entry) => !entry.isInc && entry.value).map((entry) => entry.value!.toString());
    const honors = latinHonors(cumulative.gwa, allMarks, 1, {
      summaMax: this.config.honorsSummaMax,
      magnaMax: this.config.honorsMagnaMax,
      cumLaudeMax: this.config.honorsCumLaudeMax,
      minMark: '2.50',
      minResidencyRatio: 0.75,
    });

    return {
      studentId,
      terms,
      cumulativeGwa: cumulative.gwa ? cumulative.gwa.toFixed(GWA_SCALE) : null,
      totalUnits: cumulative.totalUnits,
      standing,
      latinHonors: honors,
    };
  }
}
