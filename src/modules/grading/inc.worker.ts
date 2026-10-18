import { Decimal } from 'decimal.js';
import type { GradeLedgerEntry, PrismaClient } from '@prisma/client';
import type { Env } from '../../config/env';
import type { Clock } from '../../core/time/clock';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { runWithTenant } from '../../core/tenant/context';
import type { AuditService } from '../audit/audit.service';
import { gradeEntryHash } from './ledger-hash';
import { validateMark } from './state-machine';

export interface IncSweepReport {
  scanned: number;
  converted: Array<{ entryId: string; studentId: string; courseId: string; newEntryId: string }>;
}

/**
 * INC lifecycle (BSL-304).
 * Completion: registrar/instructor posts a numeric mark that supersedes the INC.
 * Expiry: an hourly sweep converts INC entries past `incDeadlineAt` to the
 * configured default grade (system actor, hash-linked version+1 entry).
 */
export class IncLifecycleService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly config: Pick<Env, 'incDefaultGrade'>,
  ) {}

  async complete(actorId: string, entryId: string, value: string): Promise<{ entry: GradeLedgerEntry; supersededId: string }> {
    validateMark({ kind: 'NUMERIC', value });
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.gradeLedgerEntry.findUnique({ where: { id: entryId } });
      if (!entry) throw new AppError(ErrorCodes.NOT_FOUND, 'Grade entry not found.');
      if (entry.status !== 'POSTED' || !entry.isInc) {
        throw new AppError(ErrorCodes.GRADE_STATE_INVALID, 'Only an outstanding INC (POSTED, isInc) can be completed.');
      }

      await tx.gradeLedgerEntry.update({ where: { id: entry.id }, data: { status: 'SUPERSEDED' } });

      const normalized = new Decimal(value).toFixed(2);
      const entryHash = gradeEntryHash({
        prevHash: entry.entryHash,
        studentId: entry.studentId,
        courseId: entry.courseId,
        termId: entry.termId,
        sectionId: entry.sectionId,
        mark: normalized,
        version: entry.version + 1,
        timestampIso: now.toISOString(),
      });
      const replacement = await tx.gradeLedgerEntry.create({
        data: {
          schoolId: entry.schoolId,
          studentId: entry.studentId,
          courseId: entry.courseId,
          termId: entry.termId,
          sectionId: entry.sectionId,
          sheetId: entry.sheetId,
          status: 'POSTED',
          version: entry.version + 1,
          value: normalized,
          isInc: false,
          prevEntryId: entry.id,
          prevHash: entry.entryHash,
          entryHash,
        },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.inc.completed',
        resourceType: 'grade_ledger_entry',
        resourceId: replacement.id,
        payload: { supersededEntryId: entry.id, value: normalized },
      });
      return { entry: replacement, supersededId: entry.id };
    });
  }

  /** Sweep expired INC entries → configured default grade (SYSTEM actor). */
  async sweepExpired(limit = 500): Promise<IncSweepReport> {
    const now = this.clock.now();
    const expired = await this.prisma.gradeLedgerEntry.findMany({
      where: { status: 'POSTED', isInc: true, incDeadlineAt: { not: null, lt: now } },
      take: limit,
      orderBy: { incDeadlineAt: 'asc' },
    });

    const report: IncSweepReport = { scanned: expired.length, converted: [] };
    for (const entry of expired) {
      // The scan is cross-school (system frame); each conversion runs in the
      // owning school's frame so audit events land in that school's chain.
      const converted = await runWithTenant(entry.schoolId, () =>
        this.prisma.$transaction(async (tx) => {
        const fresh = await tx.gradeLedgerEntry.findUnique({ where: { id: entry.id } });
        if (!fresh || fresh.status !== 'POSTED' || !fresh.isInc) return null;

        await tx.gradeLedgerEntry.update({ where: { id: fresh.id }, data: { status: 'SUPERSEDED' } });

        const defaultGrade = new Decimal(this.config.incDefaultGrade).toFixed(2);
        const entryHash = gradeEntryHash({
          prevHash: fresh.entryHash,
          studentId: fresh.studentId,
          courseId: fresh.courseId,
          termId: fresh.termId,
          sectionId: fresh.sectionId,
          mark: defaultGrade,
          version: fresh.version + 1,
          timestampIso: now.toISOString(),
        });
        const replacement = await tx.gradeLedgerEntry.create({
          data: {
            schoolId: fresh.schoolId,
            studentId: fresh.studentId,
            courseId: fresh.courseId,
            termId: fresh.termId,
            sectionId: fresh.sectionId,
            sheetId: fresh.sheetId,
            status: 'POSTED',
            version: fresh.version + 1,
            value: defaultGrade,
            isInc: false,
            prevEntryId: fresh.id,
            prevHash: fresh.entryHash,
            entryHash,
          },
        });
        await this.audit.append(tx, {
          actorId: null,
          action: 'grading.inc.expired_converted',
          resourceType: 'grade_ledger_entry',
          resourceId: replacement.id,
          payload: {
            supersededEntryId: fresh.id,
            incDeadlineAt: fresh.incDeadlineAt,
            convertedValue: defaultGrade,
          },
        });
        return { entryId: fresh.id, studentId: fresh.studentId, courseId: fresh.courseId, newEntryId: replacement.id };
      }),
      );
      if (converted) report.converted.push(converted);
    }
    return report;
  }
}
