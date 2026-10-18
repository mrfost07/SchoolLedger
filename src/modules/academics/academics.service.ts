import type {
  AcademicTerm,
  Course,
  CurriculumVersion,
  Department,
  PrismaClient,
  Program,
  Room,
  Section,
  SectionSchedule,
  TermStatus,
} from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { requireTenantSchoolId } from '../../core/tenant/context';
import { assertRequisiteGraphValid, topologicalOrder, unlockCounts, type RequisiteEdge } from './dag';
import {
  findScheduleConflicts,
  throwOnScheduleConflicts,
  type ConflictDiagnostic,
  type ScheduleOwner,
} from './conflicts';

export interface ScheduleInput {
  roomId: string;
  dayOfWeek: number;
  startMin: number;
  endMin: number;
}

export interface CreateSectionInput {
  termId: string;
  courseId: string;
  sectionCode: string;
  instructorId?: string;
  maxCapacity: number;
  schedules?: ScheduleInput[];
}

export const TERM_TRANSITIONS: Record<TermStatus, TermStatus[]> = {
  PLANNING: ['ENROLLMENT'],
  ENROLLMENT: ['ADD_DROP'],
  ADD_DROP: ['ONGOING'],
  ONGOING: ['GRADING'],
  GRADING: ['CLOSED'],
  CLOSED: [],
};

function assertScheduleShape(schedule: ScheduleInput): void {
  if (schedule.dayOfWeek < 1 || schedule.dayOfWeek > 7) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'dayOfWeek must be between 1 (Monday) and 7 (Sunday).');
  }
  if (schedule.startMin < 0 || schedule.endMin > 1440 || schedule.endMin <= schedule.startMin) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Invalid time slot: require 0 ≤ startMin < endMin ≤ 1440.');
  }
}

function isExclusionViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('schedule_room_no_overlap') ||
    message.includes('schedule_instructor_no_overlap') ||
    message.includes('exclusion constraint') ||
    message.includes('23P01')
  );
}

export class AcademicsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  // ── Structure ──────────────────────────────────────────────────────────────

  async createDepartment(actorId: string, input: { code: string; name: string }): Promise<Department> {
    const schoolId = requireTenantSchoolId();
    return this.prisma.$transaction(async (tx) => {
      const department = await tx.department.create({ data: { ...input, schoolId } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.department.created',
        resourceType: 'department',
        resourceId: department.id,
        payload: input,
      });
      return department;
    });
  }

  async createProgram(actorId: string, input: { code: string; name: string; degreeTitle: string; departmentId: string }): Promise<Program> {
    const schoolId = requireTenantSchoolId();
    return this.prisma.$transaction(async (tx) => {
      const program = await tx.program.create({ data: { ...input, schoolId } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.program.created',
        resourceType: 'program',
        resourceId: program.id,
        payload: input,
      });
      return program;
    });
  }

  async createCurriculumVersion(
    actorId: string,
    input: { programId: string; version: string; name: string; unitsRequired: number; effectiveFrom?: Date },
  ): Promise<CurriculumVersion> {
    const schoolId = requireTenantSchoolId();
    return this.prisma.$transaction(async (tx) => {
      const curriculum = await tx.curriculumVersion.create({
        data: { ...input, schoolId, effectiveFrom: input.effectiveFrom ?? null },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.curriculum.created',
        resourceType: 'curriculum_version',
        resourceId: curriculum.id,
        payload: input,
      });
      return curriculum;
    });
  }

  async setCurriculumStatus(actorId: string, curriculumVersionId: string, status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'): Promise<CurriculumVersion> {
    const current = await this.prisma.curriculumVersion.findUnique({ where: { id: curriculumVersionId } });
    if (!current) throw new AppError(ErrorCodes.NOT_FOUND, 'Curriculum version not found.');
    const allowed: Record<string, string[]> = { DRAFT: ['ACTIVE', 'ARCHIVED'], ACTIVE: ['ARCHIVED'], ARCHIVED: [] };
    if (!allowed[current.status]!.includes(status)) {
      throw new AppError(ErrorCodes.CONFLICT, `Cannot transition curriculum from ${current.status} to ${status}.`);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.curriculumVersion.update({ where: { id: curriculumVersionId }, data: { status } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.curriculum.status_changed',
        resourceType: 'curriculum_version',
        resourceId: curriculumVersionId,
        payload: { from: current.status, to: status },
      });
      return updated;
    });
  }

  async createCourse(
    actorId: string,
    input: { code: string; title: string; lectureUnits: number; labUnits?: number; description?: string },
  ): Promise<Course> {
    const schoolId = requireTenantSchoolId();
    return this.prisma.$transaction(async (tx) => {
      const course = await tx.course.create({
        data: {
          schoolId,
          code: input.code,
          title: input.title,
          lectureUnits: input.lectureUnits,
          labUnits: input.labUnits ?? 0,
          description: input.description ?? null,
        },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.course.created',
        resourceType: 'course',
        resourceId: course.id,
        payload: input,
      });
      return course;
    });
  }

  async addCourseToCurriculum(
    actorId: string,
    curriculumVersionId: string,
    input: { courseId: string; yearLevel: number; termNo: number; isRequired?: boolean },
  ) {
    const schoolId = requireTenantSchoolId();
    return this.prisma.$transaction(async (tx) => {
      const curriculum = await tx.curriculumVersion.findUnique({ where: { id: curriculumVersionId } });
      if (!curriculum) throw new AppError(ErrorCodes.NOT_FOUND, 'Curriculum version not found.');
      if (curriculum.status === 'ARCHIVED') throw new AppError(ErrorCodes.CONFLICT, 'Archived curricula are immutable.');
      const entry = await tx.curriculumCourse.create({
        data: {
          schoolId,
          curriculumVersionId,
          courseId: input.courseId,
          yearLevel: input.yearLevel,
          termNo: input.termNo,
          isRequired: input.isRequired ?? true,
        },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.curriculum.course_added',
        resourceType: 'curriculum_course',
        resourceId: entry.id,
        payload: { curriculumVersionId, ...input },
      });
      return entry;
    });
  }

  // ── Requisites (DAG validated) ─────────────────────────────────────────────

  async upsertRequisite(
    actorId: string,
    input: { courseId: string; requiredCourseId: string; type: RequisiteEdge['type']; minGrade?: string },
  ): Promise<RequisiteEdge & { id: string }> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize all requisite mutations: the acyclicity check must see every
      // committed edge, otherwise two concurrent upserts can close a cycle.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2, 0)`;

      const existing = await tx.courseRequisite.findMany();
      const edges: RequisiteEdge[] = existing.map((edge) => ({
        courseId: edge.courseId,
        requiredCourseId: edge.requiredCourseId,
        type: edge.type as RequisiteEdge['type'],
      }));
      const base = edges.filter(
        (edge) => !(edge.courseId === input.courseId && edge.requiredCourseId === input.requiredCourseId && edge.type === input.type),
      );
      assertRequisiteGraphValid(base, { courseId: input.courseId, requiredCourseId: input.requiredCourseId, type: input.type });

      const row = await tx.courseRequisite.upsert({
        where: {
          courseId_requiredCourseId_type: {
            courseId: input.courseId,
            requiredCourseId: input.requiredCourseId,
            type: input.type,
          },
        },
        create: {
          schoolId: requireTenantSchoolId(),
          courseId: input.courseId,
          requiredCourseId: input.requiredCourseId,
          type: input.type,
          minGrade: input.minGrade ?? null,
        },
        update: { minGrade: input.minGrade ?? null },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.requisite.upserted',
        resourceType: 'course_requisite',
        resourceId: row.id,
        payload: input,
      });
      return { id: row.id, courseId: row.courseId, requiredCourseId: row.requiredCourseId, type: row.type as RequisiteEdge['type'] };
    });
  }

  async removeRequisite(actorId: string, requisiteId: string): Promise<void> {
    const row = await this.prisma.courseRequisite.findUnique({ where: { id: requisiteId } });
    if (!row) throw new AppError(ErrorCodes.NOT_FOUND, 'Requisite not found.');
    await this.prisma.$transaction(async (tx) => {
      await tx.courseRequisite.delete({ where: { id: requisiteId } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.requisite.removed',
        resourceType: 'course_requisite',
        resourceId: requisiteId,
        payload: { courseId: row.courseId, requiredCourseId: row.requiredCourseId, type: row.type },
      });
    });
  }

  async getCurriculumGraph(curriculumVersionId: string) {
    const entries = await this.prisma.curriculumCourse.findMany({
      where: { curriculumVersionId },
      include: { course: true },
      orderBy: [{ yearLevel: 'asc' }, { termNo: 'asc' }],
    });
    const courseIds = new Set(entries.map((entry) => entry.courseId));
    const requisites = await this.prisma.courseRequisite.findMany({
      where: { courseId: { in: [...courseIds] }, requiredCourseId: { in: [...courseIds] } },
    });
    const edges: RequisiteEdge[] = requisites.map((edge) => ({
      courseId: edge.courseId,
      requiredCourseId: edge.requiredCourseId,
      type: edge.type as RequisiteEdge['type'],
    }));
    const { order, cyclic } = topologicalOrder([...courseIds], edges);
    const unlocks = unlockCounts([...courseIds], edges);
    return {
      curriculumVersionId,
      courses: entries.map((entry) => ({
        courseId: entry.courseId,
        code: entry.course.code,
        title: entry.course.title,
        yearLevel: entry.yearLevel,
        termNo: entry.termNo,
        unlocksCount: unlocks.get(entry.courseId) ?? 0,
      })),
      requisites: edges,
      topologicalOrder: order,
      isAcyclic: !cyclic,
    };
  }

  // ── Terms ──────────────────────────────────────────────────────────────────

  async createTerm(
    actorId: string,
    input: {
      code: string;
      schoolYear: number;
      termNo: number;
      startsAt: Date;
      endsAt: Date;
      enrollmentStartAt: Date;
      addDropEndAt: Date;
      gradingStartAt: Date;
      gradingEndAt: Date;
    },
  ): Promise<AcademicTerm> {
    if (
      !(input.startsAt < input.endsAt) ||
      !(input.enrollmentStartAt <= input.addDropEndAt) ||
      !(input.gradingStartAt < input.gradingEndAt)
    ) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Term windows are inconsistent (require startsAt < endsAt, enrollmentStartAt ≤ addDropEndAt, gradingStartAt < gradingEndAt).');
    }
    return this.prisma.$transaction(async (tx) => {
      const term = await tx.academicTerm.create({ data: { ...input, schoolId: requireTenantSchoolId() } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.term.created',
        resourceType: 'academic_term',
        resourceId: term.id,
        payload: { code: input.code },
      });
      return term;
    });
  }

  async setTermStatus(actorId: string, termId: string, status: TermStatus): Promise<AcademicTerm> {
    const term = await this.prisma.academicTerm.findUnique({ where: { id: termId } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, 'Term not found.');
    if (!TERM_TRANSITIONS[term.status].includes(status)) {
      throw new AppError(
        ErrorCodes.INVALID_TERM_TRANSITION,
        `Illegal term transition ${term.status} → ${status}. Allowed: ${TERM_TRANSITIONS[term.status].join(', ') || 'none'}.`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.academicTerm.update({ where: { id: termId }, data: { status } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.term.status_changed',
        resourceType: 'academic_term',
        resourceId: termId,
        payload: { from: term.status, to: status },
      });
      return updated;
    });
  }

  async listTerms(): Promise<AcademicTerm[]> {
    return this.prisma.academicTerm.findMany({ orderBy: [{ schoolYear: 'desc' }, { termNo: 'desc' }] });
  }

  async getTermOrThrow(termId: string): Promise<AcademicTerm> {
    const term = await this.prisma.academicTerm.findUnique({ where: { id: termId } });
    if (!term) throw new AppError(ErrorCodes.NOT_FOUND, 'Term not found.');
    return term;
  }

  // ── Rooms ──────────────────────────────────────────────────────────────────

  async createRoom(actorId: string, input: { code: string; building: string; capacity: number }): Promise<Room> {
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.create({ data: { ...input, schoolId: requireTenantSchoolId() } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.room.created',
        resourceType: 'room',
        resourceId: room.id,
        payload: input,
      });
      return room;
    });
  }

  async listRooms(): Promise<Room[]> {
    return this.prisma.room.findMany({ orderBy: { code: 'asc' } });
  }

  // ── Sections & schedules ───────────────────────────────────────────────────

  private async existingScheduleOwners(termId: string, excludeSectionId?: string): Promise<ScheduleOwner[]> {
    const schedules = await this.prisma.sectionSchedule.findMany({
      where: { termId },
      include: { section: { select: { sectionCode: true } } },
    });
    return schedules
      .filter((schedule) => schedule.sectionId !== excludeSectionId)
      .map((schedule) => ({
        scheduleId: schedule.id,
        sectionId: schedule.sectionId,
        sectionCode: schedule.section.sectionCode,
        roomId: schedule.roomId,
        instructorId: schedule.instructorId,
        interval: { dayOfWeek: schedule.dayOfWeek, startMin: schedule.startMin, endMin: schedule.endMin },
      }));
  }

  async createSection(actorId: string, input: CreateSectionInput): Promise<Section & { schedules: SectionSchedule[] }> {
    const term = await this.getTermOrThrow(input.termId);
    if (term.status === 'CLOSED') throw new AppError(ErrorCodes.INVALID_TERM_STATUS, 'Cannot create sections in a closed term.');
    const course = await this.prisma.course.findUnique({ where: { id: input.courseId } });
    if (!course) throw new AppError(ErrorCodes.NOT_FOUND, 'Course not found.');
    if (input.maxCapacity <= 0) throw new AppError(ErrorCodes.VALIDATION_FAILED, 'maxCapacity must be positive.');

    const schedules = input.schedules ?? [];
    if (schedules.length > 0 && !input.instructorId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'A section with schedules requires an assigned instructor.');
    }
    for (const schedule of schedules) assertScheduleShape(schedule);

    if (input.instructorId) {
      const instructor = await this.prisma.user.findUnique({ where: { id: input.instructorId } });
      if (!instructor) throw new AppError(ErrorCodes.NOT_FOUND, 'Instructor not found.');
    }

    if (schedules.length > 0) {
      const owners = await this.existingScheduleOwners(input.termId);
      const diagnostics: ConflictDiagnostic[] = [];
      for (const schedule of schedules) {
        diagnostics.push(
          ...findScheduleConflicts(
            {
              sectionId: 'new',
              sectionCode: input.sectionCode,
              roomId: schedule.roomId,
              instructorId: input.instructorId!,
              interval: schedule,
            },
            owners,
          ),
        );
      }
      throwOnScheduleConflicts(diagnostics);
    }

    try {
      const schoolId = requireTenantSchoolId();
      return await this.prisma.$transaction(async (tx) => {
        const section = await tx.section.create({
          data: {
            schoolId,
            termId: input.termId,
            courseId: input.courseId,
            sectionCode: input.sectionCode,
            instructorId: input.instructorId ?? null,
            maxCapacity: input.maxCapacity,
          },
        });
        if (schedules.length > 0) {
          await tx.sectionSchedule.createMany({
            data: schedules.map((schedule) => ({
              schoolId,
              sectionId: section.id,
              termId: input.termId,
              instructorId: input.instructorId!,
              roomId: schedule.roomId,
              dayOfWeek: schedule.dayOfWeek,
              startMin: schedule.startMin,
              endMin: schedule.endMin,
            })),
          });
        }
        await this.audit.append(tx, {
          actorId,
          action: 'academics.section.created',
          resourceType: 'section',
          resourceId: section.id,
          payload: { termId: input.termId, courseId: input.courseId, sectionCode: input.sectionCode, schedules: schedules.length },
        });
        const created = await tx.section.findUniqueOrThrow({ where: { id: section.id }, include: { schedules: true } });
        return created;
      });
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw new AppError(ErrorCodes.SCHEDULE_CONFLICT, 'Database rejected the schedule due to a room/instructor double-booking.', {
          meta: { layer: 'database' },
        });
      }
      throw error;
    }
  }

  async addSchedule(actorId: string, sectionId: string, input: ScheduleInput): Promise<SectionSchedule> {
    assertScheduleShape(input);
    const section = await this.prisma.section.findUnique({ where: { id: sectionId }, include: { term: true } });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, 'Section not found.');
    if (section.sectionCode && section.term.status === 'CLOSED') {
      throw new AppError(ErrorCodes.INVALID_TERM_STATUS, 'Cannot modify schedules in a closed term.');
    }
    if (!section.instructorId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Section has no assigned instructor; schedules require one.');
    }

    const owners = await this.existingScheduleOwners(section.termId, sectionId);
    throwOnScheduleConflicts(
      findScheduleConflicts(
        {
          sectionId,
          sectionCode: section.sectionCode,
          roomId: input.roomId,
          instructorId: section.instructorId,
          interval: input,
        },
        owners,
      ),
    );

    try {
      const schoolId = requireTenantSchoolId();
      return await this.prisma.$transaction(async (tx) => {
        const schedule = await tx.sectionSchedule.create({
          data: {
            schoolId,
            sectionId,
            termId: section.termId,
            instructorId: section.instructorId!,
            roomId: input.roomId,
            dayOfWeek: input.dayOfWeek,
            startMin: input.startMin,
            endMin: input.endMin,
          },
        });
        await this.audit.append(tx, {
          actorId,
          action: 'academics.schedule.added',
          resourceType: 'section_schedule',
          resourceId: schedule.id,
          payload: { sectionId, ...input },
        });
        return schedule;
      });
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw new AppError(ErrorCodes.SCHEDULE_CONFLICT, 'Database rejected the schedule due to a room/instructor double-booking.', {
          meta: { layer: 'database' },
        });
      }
      throw error;
    }
  }

  async removeSchedule(actorId: string, scheduleId: string): Promise<void> {
    const schedule = await this.prisma.sectionSchedule.findUnique({ where: { id: scheduleId } });
    if (!schedule) throw new AppError(ErrorCodes.NOT_FOUND, 'Schedule not found.');
    await this.prisma.$transaction(async (tx) => {
      await tx.sectionSchedule.delete({ where: { id: scheduleId } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.schedule.removed',
        resourceType: 'section_schedule',
        resourceId: scheduleId,
        payload: { sectionId: schedule.sectionId },
      });
    });
  }

  async setSectionStatus(actorId: string, sectionId: string, status: 'OPEN' | 'CLOSED' | 'CANCELLED'): Promise<Section> {
    const section = await this.prisma.section.findUnique({ where: { id: sectionId } });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, 'Section not found.');
    if (section.status === 'CANCELLED' && status !== 'CANCELLED') {
      throw new AppError(ErrorCodes.CONFLICT, 'Cancelled sections cannot be reopened.');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.section.update({ where: { id: sectionId }, data: { status } });
      await this.audit.append(tx, {
        actorId,
        action: 'academics.section.status_changed',
        resourceType: 'section',
        resourceId: sectionId,
        payload: { from: section.status, to: status },
      });
      return updated;
    });
  }

  async listSections(termId: string, courseId?: string) {
    return this.prisma.section.findMany({
      where: { termId, ...(courseId ? { courseId } : {}) },
      include: {
        course: { select: { id: true, code: true, title: true, lectureUnits: true, labUnits: true } },
        instructor: { select: { id: true, firstName: true, lastName: true } },
        schedules: { include: { room: { select: { id: true, code: true, building: true } } } },
        _count: { select: { items: { where: { status: 'ENROLLED' } } } },
      },
      orderBy: [{ course: { code: 'asc' } }, { sectionCode: 'asc' }],
    });
  }

  async getSectionOrThrow(sectionId: string) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      include: {
        course: true,
        term: true,
        instructor: { select: { id: true, firstName: true, lastName: true, email: true } },
        schedules: { include: { room: true } },
      },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, 'Section not found.');
    return section;
  }
}
