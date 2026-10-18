import { Decimal } from 'decimal.js';
import type { GradeRectification, PrismaClient } from '@prisma/client';
import type { Clock } from '../../core/time/clock';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { requireTenantSchoolId } from '../../core/tenant/context';
import type { AuditService } from '../audit/audit.service';
import { addDays } from '../../core/time/clock';
import { gradeEntryHash } from './ledger-hash';
import { validateMark, type Mark } from './state-machine';
import type { Env } from '../../config/env';

export interface CreateRectificationInput {
  entryId: string;
  proposedValue?: string | null;
  proposedIsInc?: boolean;
  reason: string;
}

/**
 * Grade rectification workflow (BSL-305):
 *
 *   PENDING ──endorse(Chair)──▶ CHAIR_ENDORSED ──approve(Registrar)──▶ APPROVED
 *      │                               │
 *      ├──reject(Chair/Registrar)──────┴──────────────────────────────▶ REJECTED
 *      └──cancel(Requester)───────────────────────────────────────────▶ CANCELLED
 *
 * Only APPROVED rectifications mutate the ledger, and they do so by
 * superseding the old POSTED row and inserting version+1 (hash-linked).
 */
export class RectificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly config: Pick<Env, 'incCompletionDays'>,
  ) {}

  async create(actorId: string, actorRoles: string[], input: CreateRectificationInput): Promise<GradeRectification> {
    const entry = await this.prisma.gradeLedgerEntry.findUnique({ where: { id: input.entryId } });
    if (!entry) throw new AppError(ErrorCodes.NOT_FOUND, 'Grade ledger entry not found.');
    if (entry.status !== 'POSTED') {
      throw new AppError(
        ErrorCodes.GRADE_STATE_INVALID,
        `Only POSTED entries can be rectified (current status: ${entry.status}). DRAFT/SUBMITTED/VERIFIED entries are edited through the sheet workflow.`,
      );
    }

    const isAdmin = actorRoles.includes('ADMIN');
    if (!isAdmin && entry.sectionId) {
      const section = await this.prisma.section.findUnique({ where: { id: entry.sectionId } });
      if (!section || section.instructorId !== actorId) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Only the assigned instructor (or ADMIN) may request rectification.');
      }
    }

    const openExisting = await this.prisma.gradeRectification.findFirst({
      where: { targetEntryId: input.entryId, status: { in: ['PENDING', 'CHAIR_ENDORSED'] } },
    });
    if (openExisting) {
      throw new AppError(ErrorCodes.CONFLICT, 'An open rectification already exists for this entry.', {
        meta: { rectificationId: openExisting.id, status: openExisting.status },
      });
    }

    if (input.proposedIsInc) {
      validateMark({ kind: 'INC' });
    } else if (input.proposedValue !== undefined && input.proposedValue !== null) {
      validateMark({ kind: 'NUMERIC', value: input.proposedValue });
    } else {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Provide proposedValue (numeric) or proposedIsInc=true.');
    }

    return this.prisma.$transaction(async (tx) => {
      const rectification = await tx.gradeRectification.create({
        data: {
          schoolId: requireTenantSchoolId(),
          targetEntryId: input.entryId,
          reason: input.reason,
          proposedValue: input.proposedIsInc ? null : input.proposedValue ?? null,
          proposedIsInc: input.proposedIsInc ?? false,
          requestedById: actorId,
          status: 'PENDING',
        },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.rectification.created',
        resourceType: 'grade_rectification',
        resourceId: rectification.id,
        payload: { entryId: input.entryId, proposedValue: input.proposedValue, proposedIsInc: !!input.proposedIsInc, reason: input.reason },
      });
      return rectification;
    });
  }

  async endorse(actorId: string, rectificationId: string, note?: string): Promise<GradeRectification> {
    return this.prisma.$transaction(async (tx) => {
      const rectification = await tx.gradeRectification.findUnique({ where: { id: rectificationId } });
      if (!rectification) throw new AppError(ErrorCodes.NOT_FOUND, 'Rectification not found.');
      if (rectification.status !== 'PENDING') {
        throw new AppError(ErrorCodes.RECTIFICATION_INVALID_STATE, `Cannot endorse a ${rectification.status} rectification.`);
      }
      const updated = await tx.gradeRectification.update({
        where: { id: rectificationId },
        data: { status: 'CHAIR_ENDORSED', endorsedById: actorId, decisionNote: note ?? null },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.rectification.endorsed',
        resourceType: 'grade_rectification',
        resourceId: rectificationId,
        payload: { note: note ?? null },
      });
      return updated;
    });
  }

  async approve(actorId: string, rectificationId: string, note?: string): Promise<{ rectification: GradeRectification; newEntryId: string }> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const rectification = await tx.gradeRectification.findUnique({ where: { id: rectificationId } });
      if (!rectification) throw new AppError(ErrorCodes.NOT_FOUND, 'Rectification not found.');
      if (rectification.status !== 'CHAIR_ENDORSED') {
        throw new AppError(ErrorCodes.RECTIFICATION_INVALID_STATE, `Approval requires CHAIR_ENDORSED (current: ${rectification.status}).`);
      }

      const target = await tx.gradeLedgerEntry.findUnique({ where: { id: rectification.targetEntryId } });
      if (!target) throw new AppError(ErrorCodes.NOT_FOUND, 'Target grade entry not found.');
      if (target.status !== 'POSTED') {
        throw new AppError(ErrorCodes.GRADE_STATE_INVALID, `Target entry is ${target.status}; only POSTED entries can be superseded.`);
      }

      const mark: Mark = rectification.proposedIsInc
        ? { kind: 'INC' }
        : { kind: 'NUMERIC', value: new Decimal(rectification.proposedValue!.toString()).toFixed(2) };

      // 1) supersede the old row (status-only update — trigger enforces this)
      await tx.gradeLedgerEntry.update({ where: { id: target.id }, data: { status: 'SUPERSEDED' } });

      // 2) insert version+1 with the hash linked to the superseded row
      const entryHash = gradeEntryHash({
        prevHash: target.entryHash,
        studentId: target.studentId,
        courseId: target.courseId,
        termId: target.termId,
        sectionId: target.sectionId,
        mark: mark.kind === 'NUMERIC' ? mark.value : mark.kind,
        version: target.version + 1,
        timestampIso: now.toISOString(),
      });
      const newEntry = await tx.gradeLedgerEntry.create({
        data: {
          schoolId: target.schoolId,
          studentId: target.studentId,
          courseId: target.courseId,
          termId: target.termId,
          sectionId: target.sectionId,
          sheetId: target.sheetId,
          status: 'POSTED',
          version: target.version + 1,
          value: mark.kind === 'NUMERIC' ? mark.value : null,
          isInc: mark.kind === 'INC',
          incDeadlineAt: mark.kind === 'INC' ? addDays(now, this.config.incCompletionDays) : null,
          prevEntryId: target.id,
          prevHash: target.entryHash,
          entryHash,
          rectificationId,
        },
      });

      const updated = await tx.gradeRectification.update({
        where: { id: rectificationId },
        data: { status: 'APPROVED', approvedById: actorId, decidedAt: now, decisionNote: note ?? null },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.rectification.approved',
        resourceType: 'grade_rectification',
        resourceId: rectificationId,
        payload: {
          targetEntryId: target.id,
          newEntryId: newEntry.id,
          oldMark: target.isInc ? 'INC' : target.value?.toString() ?? 'DRP',
          newMark: mark.kind === 'NUMERIC' ? mark.value : mark.kind,
          version: newEntry.version,
        },
      });
      return { rectification: updated, newEntryId: newEntry.id };
    });
  }

  async reject(actorId: string, rectificationId: string, note?: string): Promise<GradeRectification> {
    return this.prisma.$transaction(async (tx) => {
      const rectification = await tx.gradeRectification.findUnique({ where: { id: rectificationId } });
      if (!rectification) throw new AppError(ErrorCodes.NOT_FOUND, 'Rectification not found.');
      if (!['PENDING', 'CHAIR_ENDORSED'].includes(rectification.status)) {
        throw new AppError(ErrorCodes.RECTIFICATION_INVALID_STATE, `Cannot reject a ${rectification.status} rectification.`);
      }
      const updated = await tx.gradeRectification.update({
        where: { id: rectificationId },
        data: { status: 'REJECTED', decidedAt: this.clock.now(), decisionNote: note ?? null, approvedById: actorId },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.rectification.rejected',
        resourceType: 'grade_rectification',
        resourceId: rectificationId,
        payload: { note: note ?? null },
      });
      return updated;
    });
  }

  async cancel(actorId: string, rectificationId: string): Promise<GradeRectification> {
    return this.prisma.$transaction(async (tx) => {
      const rectification = await tx.gradeRectification.findUnique({ where: { id: rectificationId } });
      if (!rectification) throw new AppError(ErrorCodes.NOT_FOUND, 'Rectification not found.');
      if (rectification.requestedById !== actorId) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Only the requester may cancel a rectification.');
      }
      if (rectification.status !== 'PENDING') {
        throw new AppError(ErrorCodes.RECTIFICATION_INVALID_STATE, `Cannot cancel a ${rectification.status} rectification.`);
      }
      const updated = await tx.gradeRectification.update({ where: { id: rectificationId }, data: { status: 'CANCELLED' } });
      await this.audit.append(tx, {
        actorId,
        action: 'grading.rectification.cancelled',
        resourceType: 'grade_rectification',
        resourceId: rectificationId,
        payload: {},
      });
      return updated;
    });
  }

  async list(filter: { status?: string; entryId?: string } = {}): Promise<unknown[]> {
    return this.prisma.gradeRectification.findMany({
      where: {
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(filter.entryId ? { targetEntryId: filter.entryId } : {}),
      },
      include: {
        targetEntry: { include: { course: true, student: { select: { id: true, firstName: true, lastName: true } } } },
        requestedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
