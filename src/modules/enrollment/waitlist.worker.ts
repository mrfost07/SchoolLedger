import { Prisma } from '@prisma/client';
import type { EnrollmentItem, PrismaClient } from '@prisma/client';
import type { Clock } from '../../core/time/clock';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { AuditService } from '../audit/audit.service';
import type { HoldsService } from '../iam/holds.service';
import { summarizeStudentConflicts } from '../academics/conflicts';
import type { CapacityGate } from './capacity';
import type { EligibilityService } from './eligibility.service';
import type { FeesService } from './fees.service';

export interface PromotionReport {
  sectionId: string;
  promoted: Array<{ itemId: string; studentId: string }>;
  removed: Array<{ itemId: string; studentId: string; reason: string }>;
  stoppedBecause: 'EMPTY_WAITLIST' | 'SECTION_FULL' | 'WINDOW_CLOSED' | 'MAX_ITERATIONS';
}

/**
 * Waitlist auto-promotion worker (BSL-204).
 *
 * FIFO: the oldest WAITLISTED item is examined first. Ineligible waiters are
 * removed from the queue (with an audit reason) so the next eligible student
 * gets the slot. Promotion re-validates clearance, prerequisites, schedule
 * conflicts and capacity inside a row-locked transaction, then synchronizes the
 * Redis slot counter to the authoritative database state.
 */
export class WaitlistPromotionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly holds: HoldsService,
    private readonly eligibility: EligibilityService,
    private readonly gate: CapacityGate,
    private readonly fees: FeesService,
    private readonly clock: Clock,
  ) {}

  async promote(termId: string, sectionId: string): Promise<PromotionReport> {
    const report: PromotionReport = { sectionId, promoted: [], removed: [], stoppedBecause: 'EMPTY_WAITLIST' };

    const term = await this.prisma.academicTerm.findUnique({ where: { id: termId } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, 'Term not found.');
    const now = this.clock.now();
    if ((term.status !== 'ENROLLMENT' && term.status !== 'ADD_DROP') || now > term.addDropEndAt) {
      report.stoppedBecause = 'WINDOW_CLOSED';
      return report;
    }

    const maxIterations = 200;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const candidate = await this.prisma.enrollmentItem.findFirst({
        where: { sectionId, status: 'WAITLISTED', enrollment: { termId } },
        orderBy: { createdAt: 'asc' },
        include: {
          enrollment: { include: { student: { select: { id: true } } } },
          section: {
            include: {
              course: { select: { id: true, code: true, lectureUnits: true, labUnits: true } },
              schedules: { select: { dayOfWeek: true, startMin: true, endMin: true } },
            },
          },
        },
      });
      if (!candidate) {
        report.stoppedBecause = 'EMPTY_WAITLIST';
        break;
      }

      const studentId = candidate.enrollment.studentId;
      const invalidReason = await this.validateCandidate(candidate, termId);

      if (invalidReason) {
        await this.removeFromWaitlist(candidate, invalidReason);
        report.removed.push({ itemId: candidate.id, studentId, reason: invalidReason });
        continue;
      }

      const promoted = await this.tryPromote(candidate);
      if (!promoted) {
        report.stoppedBecause = 'SECTION_FULL';
        break;
      }

      report.promoted.push({ itemId: candidate.id, studentId });

      // Keep Redis admission control consistent with the authoritative DB state.
      const section = await this.prisma.section.findUniqueOrThrow({ where: { id: sectionId } });
      await this.gate
        .syncSection(termId, sectionId, section.maxCapacity - section.enrolledCount)
        .catch(() => undefined);
      await this.fees.assess(null, candidate.enrollmentId).catch(() => undefined);
    }

    if (report.promoted.length >= maxIterations) report.stoppedBecause = 'MAX_ITERATIONS';
    return report;
  }

  private async validateCandidate(
    candidate: EnrollmentItem & {
      enrollment: { studentId: string };
      section: { id: string; courseId: string; sectionCode: string; schedules: Array<{ dayOfWeek: number; startMin: number; endMin: number }> };
    },
    termId: string,
  ): Promise<string | null> {
    const studentId = candidate.enrollment.studentId;

    const holds = await this.holds.activeHolds(studentId, {});
    if (holds.length > 0) return `Active ${holds[0]!.type} hold`;

    const state = await this.eligibility.loadState(studentId, termId);
    const passed = state.passed.get(candidate.section.courseId);
    if (passed && passed.bestValue.lessThanOrEqualTo(this.eligibility.passingThreshold())) {
      return 'Course already passed';
    }

    try {
      await this.eligibility.assertReservationEligible(studentId, termId, new Set([candidate.section.courseId]));
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === ErrorCodes.PREREQUISITE_NOT_MET) return 'Prerequisites no longer satisfied';
        if (error.code === ErrorCodes.COREQUISITE_NOT_MET) return 'Corequisite requirements no longer satisfied';
      }
      throw error;
    }

    const intervals = candidate.section.schedules.map((schedule) => ({
      dayOfWeek: schedule.dayOfWeek,
      startMin: schedule.startMin,
      endMin: schedule.endMin,
    }));
    const conflicts = summarizeStudentConflicts(
      candidate.section.id,
      candidate.section.sectionCode,
      intervals,
      await this.enrolledSections(studentId, termId),
    );
    if (conflicts.length > 0) return conflicts[0]!.message;

    return null;
  }

  private async enrolledSections(studentId: string, termId: string) {
    const items = await this.prisma.enrollmentItem.findMany({
      where: { status: 'ENROLLED', enrollment: { studentId, termId } },
      include: { section: { select: { id: true, sectionCode: true, schedules: { select: { dayOfWeek: true, startMin: true, endMin: true } } } } },
    });
    return items.map((item) => ({
      sectionId: item.section.id,
      sectionCode: item.section.sectionCode,
      intervals: item.section.schedules.map((schedule) => ({
        dayOfWeek: schedule.dayOfWeek,
        startMin: schedule.startMin,
        endMin: schedule.endMin,
      })),
    }));
  }

  private async removeFromWaitlist(candidate: EnrollmentItem & { enrollment: { studentId: string } }, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.enrollmentItem.findUnique({ where: { id: candidate.id } });
      if (!fresh || fresh.status !== 'WAITLISTED') return;

      await tx.enrollmentItem.update({ where: { id: candidate.id }, data: { status: 'DROPPED', droppedAt: this.clock.now() } });
      await tx.section.updateMany({
        where: { id: candidate.sectionId, waitlistCount: { gt: 0 } },
        data: { waitlistCount: { decrement: 1 } },
      });
      await this.audit.append(tx, {
        actorId: null,
        action: 'enrollment.waitlist_removed',
        resourceType: 'enrollment_item',
        resourceId: candidate.id,
        payload: { sectionId: candidate.sectionId, studentId: candidate.enrollment.studentId, reason },
      });
    });
  }

  private async tryPromote(
    candidate: EnrollmentItem & { enrollmentId: string; enrollment: { studentId: string } },
  ): Promise<boolean> {
    const promoted = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; enrolledCount: number; maxCapacity: number; status: string }>>`
        SELECT id, "enrolledCount", "maxCapacity", status::text AS status
        FROM sections
        WHERE id = ${candidate.sectionId}::uuid
        FOR UPDATE
      `;
      const section = locked[0];
      if (!section || section.status !== 'OPEN' || section.enrolledCount >= section.maxCapacity) return false;

      const fresh = await tx.enrollmentItem.findUnique({ where: { id: candidate.id } });
      if (!fresh || fresh.status !== 'WAITLISTED') return false;

      await tx.enrollmentItem.update({
        where: { id: candidate.id },
        data: { status: 'ENROLLED', enrolledAt: this.clock.now() },
      });
      await tx.section.update({
        where: { id: candidate.sectionId },
        data: { enrolledCount: { increment: 1 }, waitlistCount: { decrement: 1 } },
      });
      await tx.enrollment.update({
        where: { id: candidate.enrollmentId },
        data: { status: 'ENROLLED', confirmedAt: this.clock.now() },
      });
      await this.audit.append(tx, {
        actorId: null,
        action: 'enrollment.waitlist_promoted',
        resourceType: 'enrollment_item',
        resourceId: candidate.id,
        payload: { sectionId: candidate.sectionId, studentId: candidate.enrollment.studentId },
      });
      return true;
    });
    return promoted;
  }
}

export type WaitlistCandidate = Prisma.EnrollmentItemGetPayload<{
  include: { enrollment: { include: { student: { select: { id: true } } } }; section: true };
}>;
