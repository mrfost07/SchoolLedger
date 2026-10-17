import { Prisma } from '@prisma/client';
import type { Enrollment, EnrollmentItem, PrismaClient, TuitionAssessment } from '@prisma/client';
import type { Env } from '../../config/env';
import type { BackgroundDispatcher } from '../../context';
import type { Clock } from '../../core/time/clock';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { AuditService } from '../audit/audit.service';
import type { HoldsService } from '../iam/holds.service';
import type { ConflictDiagnostic, Interval } from '../academics/conflicts';
import { summarizeStudentConflicts } from '../academics/conflicts';
import type { CapacityGate, ReservationSection } from './capacity';
import { encodeReservationPayload } from './capacity';
import type { EligibilityService } from './eligibility.service';
import type { FeesService } from './fees.service';

export interface ReserveInput {
  termId: string;
  sectionIds: string[];
  allowOverload?: boolean;
}

export interface ReserveResult {
  enrollment: Enrollment;
  items: EnrollmentItem[];
  assessment: TuitionAssessment | null;
}

interface SectionForReservation {
  id: string;
  termId: string;
  courseId: string;
  sectionCode: string;
  instructorId: string | null;
  maxCapacity: number;
  enrolledCount: number;
  waitlistCount: number;
  status: string;
  course: { id: string; code: string; title: string; lectureUnits: number; labUnits: number };
  schedules: Array<{ dayOfWeek: number; startMin: number; endMin: number }>;
}

interface LockedSectionRow {
  id: string;
  enrolledCount: number;
  maxCapacity: number;
  status: string;
}

export class EnrollmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly holds: HoldsService,
    private readonly eligibility: EligibilityService,
    private readonly gate: CapacityGate,
    private readonly fees: FeesService,
    private readonly clock: Clock,
    private readonly config: Pick<Env, 'maxAcademicUnits'>,
    private readonly dispatcher: BackgroundDispatcher,
  ) {}

  // ── Shared helpers ─────────────────────────────────────────────────────────

  private intervalsOf(section: { schedules: Array<{ dayOfWeek: number; startMin: number; endMin: number }> }): Interval[] {
    return section.schedules.map((schedule) => ({
      dayOfWeek: schedule.dayOfWeek,
      startMin: schedule.startMin,
      endMin: schedule.endMin,
    }));
  }

  private async loadSections(termId: string, sectionIds: string[]): Promise<SectionForReservation[]> {
    const sections = await this.prisma.section.findMany({
      where: { id: { in: sectionIds } },
      include: {
        course: { select: { id: true, code: true, title: true, lectureUnits: true, labUnits: true } },
        schedules: { select: { dayOfWeek: true, startMin: true, endMin: true } },
      },
    });
    if (sections.length !== sectionIds.length) {
      const found = new Set(sections.map((section) => section.id));
      const missing = sectionIds.filter((id) => !found.has(id));
      throw new AppError(ErrorCodes.NOT_FOUND, `Sections not found: ${missing.join(', ')}`, { meta: { missing } });
    }
    for (const section of sections) {
      if (section.termId !== termId) {
        throw new AppError(ErrorCodes.VALIDATION_FAILED, `Section ${section.sectionCode} does not belong to term ${termId}.`);
      }
      if (section.status !== 'OPEN') {
        throw new AppError(ErrorCodes.SECTION_NOT_OPEN, `Section ${section.sectionCode} is ${section.status}.`);
      }
    }
    return sections as SectionForReservation[];
  }

  private assertEnrollmentWindow(term: { status: string; enrollmentStartAt: Date; addDropEndAt: Date }): void {
    const now = this.clock.now();
    const inWindow = now >= term.enrollmentStartAt && now <= term.addDropEndAt;
    const statusAllows = term.status === 'ENROLLMENT' || term.status === 'ADD_DROP';
    if (!inWindow || !statusAllows) {
      throw new AppError(
        ErrorCodes.ENROLLMENT_WINDOW_CLOSED,
        `Enrollment mutations are only allowed during the enrollment/add-drop window (term status: ${term.status}).`,
        { meta: { enrollmentStartAt: term.enrollmentStartAt, addDropEndAt: term.addDropEndAt, now } },
      );
    }
  }

  private async studentScheduleConflicts(
    studentId: string,
    termId: string,
    requested: Array<{ sectionId: string; sectionCode: string; intervals: Interval[] }>,
    excludeItemIds: string[] = [],
  ): Promise<ConflictDiagnostic[]> {
    const enrolledItems = await this.prisma.enrollmentItem.findMany({
      where: {
        status: 'ENROLLED',
        enrollment: { studentId, termId },
        ...(excludeItemIds.length > 0 ? { id: { notIn: excludeItemIds } } : {}),
      },
      include: { section: { select: { id: true, sectionCode: true, schedules: { select: { dayOfWeek: true, startMin: true, endMin: true } } } } },
    });
    const existingSections = enrolledItems.map((item) => ({
      sectionId: item.section.id,
      sectionCode: item.section.sectionCode,
      intervals: item.section.schedules.map((schedule) => ({
        dayOfWeek: schedule.dayOfWeek,
        startMin: schedule.startMin,
        endMin: schedule.endMin,
      })),
    }));

    const diagnostics: ConflictDiagnostic[] = [];
    for (const section of requested) {
      diagnostics.push(...summarizeStudentConflicts(section.sectionId, section.sectionCode, section.intervals, existingSections));
    }
    // intra-batch overlaps
    for (let i = 0; i < requested.length; i += 1) {
      for (let j = i + 1; j < requested.length; j += 1) {
        diagnostics.push(
          ...summarizeStudentConflicts(
            requested[j]!.sectionId,
            requested[j]!.sectionCode,
            requested[j]!.intervals,
            [{ sectionId: requested[i]!.sectionId, sectionCode: requested[i]!.sectionCode, intervals: requested[i]!.intervals }],
          ),
        );
      }
    }
    return diagnostics;
  }

  private async activeUnits(studentId: string, termId: string, excludeItemId?: string): Promise<number> {
    const items = await this.prisma.enrollmentItem.findMany({
      where: {
        status: 'ENROLLED',
        enrollment: { studentId, termId },
        ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
      },
      select: { unitsAtReservation: true },
    });
    return items.reduce((sum, item) => sum + Number(item.unitsAtReservation.toString()), 0);
  }

  // ── Reserve (atomic slot reservation) ──────────────────────────────────────

  async reserve(studentId: string, input: ReserveInput): Promise<ReserveResult> {
    if (input.sectionIds.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'At least one section is required.');
    }
    const uniqueSectionIds = [...new Set(input.sectionIds)];

    const term = await this.prisma.academicTerm.findUnique({ where: { id: input.termId } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, 'Term not found.');
    this.assertEnrollmentWindow(term);

    // StudentClearanceGuard (BSL-007)
    await this.holds.assertClearance(studentId, {});

    const sections = await this.loadSections(input.termId, uniqueSectionIds);
    const requestedCourseIds = new Set(sections.map((section) => section.courseId));
    if (requestedCourseIds.size !== sections.length) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Only one section per course may be reserved at a time.');
    }

    // Duplicate active enrollment for the same section?
    const duplicates = await this.prisma.enrollmentItem.findMany({
      where: {
        sectionId: { in: uniqueSectionIds },
        status: { in: ['ENROLLED', 'WAITLISTED'] },
        enrollment: { studentId, termId: input.termId },
      },
    });
    if (duplicates.length > 0) {
      throw new AppError(ErrorCodes.ALREADY_ENROLLED, 'You already have an active enrollment or waitlist entry for one of these sections.', {
        meta: { sectionIds: duplicates.map((item) => item.sectionId) },
      });
    }

    // Eligibility (BSL-201) — also returns academic state.
    const state = await this.eligibility.assertReservationEligible(studentId, input.termId, requestedCourseIds);

    // Already-passed guard.
    for (const section of sections) {
      if (state.passed.has(section.courseId)) {
        const best = state.passed.get(section.courseId)!;
        if (best.bestValue.lessThanOrEqualTo(this.eligibility.passingThreshold())) {
          throw new AppError(ErrorCodes.CONFLICT, `Course ${section.course.code} is already passed (${best.bestValue.toFixed(2)}).`, {
            meta: { courseId: section.courseId, bestValue: best.bestValue.toFixed(2) },
          });
        }
      }
    }

    // Max academic load (BSL-206).
    const requestedUnits = sections.reduce((sum, section) => sum + section.course.lectureUnits + section.course.labUnits, 0);
    const currentUnits = await this.activeUnits(studentId, input.termId);
    if (!input.allowOverload && currentUnits + requestedUnits > this.config.maxAcademicUnits) {
      throw new AppError(
        ErrorCodes.MAX_UNITS_EXCEEDED,
        `Reservation would exceed the ${this.config.maxAcademicUnits}-unit academic load limit (current ${currentUnits} + requested ${requestedUnits}).`,
        { meta: { currentUnits, requestedUnits, limit: this.config.maxAcademicUnits } },
      );
    }

    // Service-layer conflict diagnostics (layer 2).
    const requestedSections = sections.map((section) => ({
      sectionId: section.id,
      sectionCode: section.sectionCode,
      intervals: this.intervalsOf(section),
    }));
    const conflicts = await this.studentScheduleConflicts(studentId, input.termId, requestedSections);
    if (conflicts.length > 0) {
      throw new AppError(ErrorCodes.SCHEDULE_CONFLICT_STUDENT, conflicts[0]!.message, { meta: { conflicts } });
    }

    // Redis Lua admission control (layer 3, atomic under concurrency).
    const reservationSections: ReservationSection[] = sections.map((section) => ({
      sectionId: section.id,
      maxCapacity: section.maxCapacity,
      enrolledCount: section.enrolledCount,
      intervals: this.intervalsOf(section),
    }));
    const reservation = { studentId, termId: input.termId, sections: reservationSections };

    let gateAcquired = false;
    if (this.gate.kind === 'redis') {
      await this.gate.ensureInitialized(
        input.termId,
        sections.map((section) => ({
          sectionId: section.id,
          maxCapacity: section.maxCapacity,
          enrolledCount: section.enrolledCount,
        })),
      );
      const outcome = await this.gate.tryReserve(reservation);
      if (!outcome.ok) {
        if (outcome.code === 'SECTION_FULL' && outcome.meta?.missingSlots) {
          // Counter cache miss — fall through to the database path (degraded).
        } else if (outcome.code === 'SECTION_FULL') {
          const full = sections.find((section) => section.id === outcome.sectionIds[0]);
          throw new AppError(
            ErrorCodes.SECTION_FULL,
            full ? `Section ${full.sectionCode} is full.` : 'One of the requested sections is full.',
            { meta: { sectionIds: outcome.sectionIds } },
          );
        } else {
          throw new AppError(
            ErrorCodes.SCHEDULE_CONFLICT_STUDENT,
            'The reservation conflicts with the student schedule (detected atomically).',
            { meta: outcome.meta ?? {} },
          );
        }
      } else {
        gateAcquired = true;
      }
    }

    try {
      const result = await this.commitReservation(studentId, input, sections, requestedUnits);
      return result;
    } catch (error) {
      if (gateAcquired) {
        await this.gate.release(reservation).catch(() => undefined);
      }
      throw error;
    }
  }

  private async commitReservation(
    studentId: string,
    input: ReserveInput,
    sections: SectionForReservation[],
    requestedUnits: number,
  ): Promise<ReserveResult> {
    const ids = sections.map((section) => section.id).sort();
    const now = this.clock.now();

    const result = await this.prisma.$transaction(async (tx) => {
      // Per-student serialization: closes the max-units and duplicate-item TOCTOU
      // races that section locks alone cannot cover (two different sections).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1, hashtext(${studentId}))`;

      const activeItems = await tx.enrollmentItem.findMany({
        where: {
          enrollment: { studentId, termId: input.termId },
          status: { in: ['ENROLLED', 'WAITLISTED'] },
        },
        select: { sectionId: true, status: true, unitsAtReservation: true },
      });
      if (activeItems.some((item) => ids.includes(item.sectionId))) {
        throw new AppError(ErrorCodes.ALREADY_ENROLLED, 'You already have an active enrollment or waitlist entry for one of these sections.', {
          meta: { sectionIds: activeItems.filter((item) => ids.includes(item.sectionId)).map((item) => item.sectionId) },
        });
      }
      const committedUnits = activeItems
        .filter((item) => item.status === 'ENROLLED')
        .reduce((sum, item) => sum + Number(item.unitsAtReservation.toString()), 0);
      if (!input.allowOverload && committedUnits + requestedUnits > this.config.maxAcademicUnits) {
        throw new AppError(
          ErrorCodes.MAX_UNITS_EXCEEDED,
          `Reservation would exceed the ${this.config.maxAcademicUnits}-unit academic load limit (current ${committedUnits} + requested ${requestedUnits}).`,
          { meta: { currentUnits: committedUnits, requestedUnits, limit: this.config.maxAcademicUnits } },
        );
      }

      // Deterministic lock ordering eliminates deadlocks under enrollment rushes.
      const idList = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
      const locked = await tx.$queryRaw<LockedSectionRow[]>(Prisma.sql`
        SELECT id, "enrolledCount", "maxCapacity", status::text AS status
        FROM sections
        WHERE id IN (${idList})
        ORDER BY id ASC
        FOR UPDATE
      `);
      if (locked.length !== ids.length) {
        throw new AppError(ErrorCodes.NOT_FOUND, 'One of the sections disappeared during reservation.');
      }
      for (const row of locked) {
        if (row.status !== 'OPEN') {
          throw new AppError(ErrorCodes.SECTION_NOT_OPEN, 'A requested section is no longer open.');
        }
        if (row.enrolledCount >= row.maxCapacity) {
          throw new AppError(ErrorCodes.SECTION_FULL, 'A requested section filled up during reservation.');
        }
      }

      const enrollment = await this.upsertEnrollment(tx, studentId, input.termId, now);

      const createdItems: EnrollmentItem[] = [];
      for (const section of sections) {
        const item = await tx.enrollmentItem.create({
          data: {
            enrollmentId: enrollment.id,
            sectionId: section.id,
            status: 'ENROLLED',
            unitsAtReservation: new Prisma.Decimal(section.course.lectureUnits + section.course.labUnits),
            enrolledAt: now,
          },
        });
        createdItems.push(item);

        // Defense-in-depth capacity guard (INV-1).
        const updated = await tx.section.updateMany({
          where: { id: section.id, enrolledCount: { lt: section.maxCapacity } },
          data: { enrolledCount: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new AppError(ErrorCodes.SECTION_FULL, `Section ${section.sectionCode} reached capacity.`);
        }
      }

      await this.audit.append(tx, {
        actorId: studentId,
        action: 'enrollment.reserved',
        resourceType: 'enrollment',
        resourceId: enrollment.id,
        payload: {
          termId: input.termId,
          sectionIds: ids,
          units: requestedUnits,
          allowOverload: input.allowOverload ?? false,
        },
      });

      return { enrollment, items: createdItems };
    });

    const assessment = await this.fees.assess(studentId, result.enrollment.id).catch((error) => {
      if (error instanceof AppError && error.code === ErrorCodes.CONFLICT) return null;
      throw error;
    });

    return { enrollment: result.enrollment, items: result.items, assessment };
  }

  private async upsertEnrollment(tx: Prisma.TransactionClient, studentId: string, termId: string, now: Date): Promise<Enrollment> {
    const existing = await tx.enrollment.findUnique({ where: { studentId_termId: { studentId, termId } } });
    if (!existing) {
      return tx.enrollment.create({
        data: { studentId, termId, status: 'ENROLLED', confirmedAt: now },
      });
    }
    if (existing.status === 'CANCELLED') {
      throw new AppError(ErrorCodes.CONFLICT, 'This enrollment was cancelled and cannot be reactivated.');
    }
    if (existing.status === 'DROPPED') {
      return tx.enrollment.update({
        where: { id: existing.id },
        data: { status: 'ENROLLED', confirmedAt: now },
      });
    }
    return existing;
  }

  // ── Drop ───────────────────────────────────────────────────────────────────

  async dropItem(studentId: string, itemId: string): Promise<{ item: EnrollmentItem; promoted: boolean }> {
    const item = await this.prisma.enrollmentItem.findUnique({
      where: { id: itemId },
      include: { enrollment: true, section: { include: { schedules: true } } },
    });
    if (!item) throw new AppError(ErrorCodes.NOT_FOUND, 'Enrollment item not found.');
    if (item.enrollment.studentId !== studentId) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'You can only drop your own enrollment items.');
    }
    const term = await this.prisma.academicTerm.findUnique({ where: { id: item.enrollment.termId } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, 'Term not found.');
    this.assertEnrollmentWindow(term);

    if (item.status === 'DROPPED') throw new AppError(ErrorCodes.NOT_ENROLLED, 'Item is already dropped.');

    const now = this.clock.now();

    const { nextItem, wasEnrolled } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sections WHERE id = ${item.sectionId}::uuid FOR UPDATE`;

      // Re-read under the section lock: a concurrent drop of the same item
      // serializes here and must not decrement the counters twice.
      const fresh = await tx.enrollmentItem.findUnique({ where: { id: itemId } });
      if (!fresh || fresh.status === 'DROPPED') {
        throw new AppError(ErrorCodes.NOT_ENROLLED, 'Item is already dropped.');
      }
      const droppedFromEnrolled = fresh.status === 'ENROLLED';

      const dropped = await tx.enrollmentItem.update({
        where: { id: itemId },
        data: { status: 'DROPPED', droppedAt: now },
      });

      if (droppedFromEnrolled) {
        await tx.section.updateMany({
          where: { id: item.sectionId, enrolledCount: { gt: 0 } },
          data: { enrolledCount: { decrement: 1 } },
        });
      } else {
        await tx.section.updateMany({
          where: { id: item.sectionId, waitlistCount: { gt: 0 } },
          data: { waitlistCount: { decrement: 1 } },
        });
      }

      const remaining = await tx.enrollmentItem.count({
        where: { enrollmentId: item.enrollmentId, status: { in: ['ENROLLED', 'WAITLISTED'] } },
      });
      if (remaining === 0) {
        await tx.enrollment.update({ where: { id: item.enrollmentId }, data: { status: 'DROPPED' } });
      }

      await this.audit.append(tx, {
        actorId: studentId,
        action: droppedFromEnrolled ? 'enrollment.dropped' : 'enrollment.waitlist_left',
        resourceType: 'enrollment_item',
        resourceId: itemId,
        payload: { sectionId: item.sectionId, enrollmentId: item.enrollmentId },
      });

      return { nextItem: dropped, wasEnrolled: droppedFromEnrolled };
    });

    // Release the Redis slot + interval registration (BSL-202 compensation).
    if (wasEnrolled) {
      const intervals = item.section.schedules.map((schedule) => ({
        dayOfWeek: schedule.dayOfWeek,
        startMin: schedule.startMin,
        endMin: schedule.endMin,
      }));
      await this.gate
        .release({
          studentId,
          termId: item.enrollment.termId,
          sections: [
            {
              sectionId: item.sectionId,
              maxCapacity: item.section.maxCapacity,
              enrolledCount: item.section.enrolledCount,
              intervals,
            },
          ],
        })
        .catch(() => undefined);
    }

    // Refresh (or void) the assessment for the mutated enrollment.
    const activeItems = await this.prisma.enrollmentItem.count({
      where: { enrollmentId: item.enrollmentId, status: 'ENROLLED' },
    });
    if (activeItems > 0) {
      await this.fees.assess(studentId, item.enrollmentId).catch(() => undefined);
    } else {
      await this.prisma.tuitionAssessment
        .updateMany({ where: { enrollmentId: item.enrollmentId, status: 'ASSESSED' }, data: { status: 'VOID' } })
        .catch(() => undefined);
    }

    // Waitlist auto-promotion (BSL-204).
    let promoted = false;
    if (wasEnrolled && item.section.waitlistCount > 0) {
      await this.dispatcher.enqueueWaitlistPromotion(item.enrollment.termId, item.sectionId);
      promoted = true;
    }

    return { item: nextItem, promoted };
  }

  // ── Waitlist ───────────────────────────────────────────────────────────────

  async joinWaitlist(studentId: string, termId: string, sectionId: string): Promise<EnrollmentItem> {
    const term = await this.prisma.academicTerm.findUnique({ where: { id: termId } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, 'Term not found.');
    this.assertEnrollmentWindow(term);
    await this.holds.assertClearance(studentId, {});

    const sections = await this.loadSections(termId, [sectionId]);
    const section = sections[0]!;
    if (section.enrolledCount < section.maxCapacity) {
      throw new AppError(ErrorCodes.WAITLIST_NOT_AVAILABLE, 'Section still has open slots — enroll directly.', {
        meta: { enrolledCount: section.enrolledCount, maxCapacity: section.maxCapacity },
      });
    }

    await this.eligibility.assertReservationEligible(studentId, termId, new Set([section.courseId]));

    const requested = [{ sectionId: section.id, sectionCode: section.sectionCode, intervals: this.intervalsOf(section) }];
    const conflicts = await this.studentScheduleConflicts(studentId, termId, requested);
    if (conflicts.length > 0) {
      throw new AppError(ErrorCodes.SCHEDULE_CONFLICT_STUDENT, conflicts[0]!.message, { meta: { conflicts } });
    }

    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.enrollmentItem.findFirst({
        where: {
          sectionId,
          status: { in: ['ENROLLED', 'WAITLISTED'] },
          enrollment: { studentId, termId },
        },
      });
      if (existing) {
        throw new AppError(ErrorCodes.ALREADY_ENROLLED, 'Already enrolled or waitlisted for this section.');
      }

      const enrollment = await this.upsertEnrollment(tx, studentId, termId, now);
      const item = await tx.enrollmentItem.create({
        data: {
          enrollmentId: enrollment.id,
          sectionId,
          status: 'WAITLISTED',
          unitsAtReservation: new Prisma.Decimal(section.course.lectureUnits + section.course.labUnits),
        },
      });
      await tx.section.update({ where: { id: sectionId }, data: { waitlistCount: { increment: 1 } } });
      await this.audit.append(tx, {
        actorId: studentId,
        action: 'enrollment.waitlisted',
        resourceType: 'enrollment_item',
        resourceId: item.id,
        payload: { sectionId, termId },
      });
      return item;
    });
  }

  async listWaitlist(termId: string, sectionId: string) {
    return this.prisma.enrollmentItem.findMany({
      where: { sectionId, status: 'WAITLISTED', enrollment: { termId } },
      include: {
        enrollment: { include: { student: { select: { id: true, firstName: true, lastName: true, email: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getEnrollment(studentId: string, termId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_termId: { studentId, termId } },
      include: {
        items: {
          include: {
            section: {
              include: {
                course: true,
                schedules: { include: { room: true } },
                instructor: { select: { id: true, firstName: true, lastName: true } },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        assessment: true,
      },
    });
    if (!enrollment) throw new AppError(ErrorCodes.NOT_FOUND, 'No enrollment found for this student/term.');
    return enrollment;
  }

  /** Used by the waitlist worker: promote is only valid while the window is open. */
  assertPromotionWindow(term: { status: string; addDropEndAt: Date }): boolean {
    const now = this.clock.now();
    return (term.status === 'ENROLLMENT' || term.status === 'ADD_DROP') && now <= term.addDropEndAt;
  }
}

export { encodeReservationPayload };
