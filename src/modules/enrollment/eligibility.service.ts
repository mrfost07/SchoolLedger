import { Decimal } from 'decimal.js';
import type { PrismaClient } from '@prisma/client';
import type { Env } from '../../config/env';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { unlockCounts, type RequisiteEdge } from '../academics/dag';

export interface PassedCourse {
  courseId: string;
  bestValue: Decimal;
  termId: string;
}

export interface StudentAcademicState {
  studentId: string;
  curriculumVersionId: string;
  programId: string;
  passed: Map<string, PassedCourse>;
  enrolledCourseIds: Set<string>;
  waitlistedCourseIds: Set<string>;
  requisites: RequisiteEdge[];
}

export interface EligibilityBlock {
  courseId: string;
  code: string;
  title: string;
  reason: 'MISSING_PREREQUISITES' | 'REQUIRES_COENROLLMENT';
  missingPrerequisites: Array<{ courseId: string; code: string; minGrade: string | null; requiredType: RequisiteEdge['type'] }>;
}

export interface EligibilityResult {
  studentId: string;
  termId: string;
  curriculumVersionId: string;
  eligible: Array<{
    courseId: string;
    code: string;
    title: string;
    lectureUnits: number;
    labUnits: number;
    yearLevel: number;
    termNo: number;
    unlocksCount: number;
  }>;
  blocked: EligibilityBlock[];
  alreadyPassed: Array<{ courseId: string; code: string; title: string; bestValue: string }>;
  consumedThisTerm: Array<{ courseId: string; code: string; title: string; status: 'ENROLLED' | 'WAITLISTED'; sectionId: string }>;
}

/**
 * Prerequisite & curriculum evaluation (BSL-201).
 * Prerequisites are satisfied ONLY by POSTED, non-superseded, non-INC numeric
 * entries with value ≤ minGrade (edge-specific) or ≤ PASSING_GRADE_MAX.
 * COREQUISITE/CONCURRENT edges are satisfied by passing the course OR by
 * co-enrolling in the same reservation/term.
 */
export class EligibilityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: Pick<Env, 'passingGradeMax'>,
  ) {}

  passingThreshold(): Decimal {
    return new Decimal(this.config.passingGradeMax);
  }

  async loadState(studentId: string, termId: string): Promise<StudentAcademicState> {
    const profile = await this.prisma.studentProfile.findUnique({ where: { userId: studentId } });
    if (!profile) {
      throw new AppError(ErrorCodes.STUDENT_PROFILE_REQUIRED, 'Enrollment requires a student profile.');
    }

    const entries = await this.prisma.gradeLedgerEntry.findMany({
      where: { studentId, status: 'POSTED', isInc: false, value: { not: null } },
      select: { courseId: true, value: true, termId: true },
    });

    const passed = new Map<string, PassedCourse>();
    for (const entry of entries) {
      const value = new Decimal(entry.value!.toString());
      const existing = passed.get(entry.courseId);
      if (!existing || value.lessThan(existing.bestValue)) {
        passed.set(entry.courseId, { courseId: entry.courseId, bestValue: value, termId: entry.termId });
      }
    }

    const items = await this.prisma.enrollmentItem.findMany({
      where: { enrollment: { studentId, termId }, status: { in: ['ENROLLED', 'WAITLISTED'] } },
      include: { section: { select: { courseId: true } } },
    });
    const enrolledCourseIds = new Set<string>();
    const waitlistedCourseIds = new Set<string>();
    for (const item of items) {
      if (item.status === 'ENROLLED') enrolledCourseIds.add(item.section.courseId);
      else waitlistedCourseIds.add(item.section.courseId);
    }

    const requisiteRows = await this.prisma.courseRequisite.findMany();
    const requisites: RequisiteEdge[] = requisiteRows.map((row) => ({
      courseId: row.courseId,
      requiredCourseId: row.requiredCourseId,
      type: row.type as RequisiteEdge['type'],
    }));

    return {
      studentId,
      curriculumVersionId: profile.curriculumVersionId,
      programId: profile.programId,
      passed,
      enrolledCourseIds,
      waitlistedCourseIds,
      requisites,
    };
  }

  private isPassed(state: StudentAcademicState, courseId: string, minGrade: string | null): boolean {
    const record = state.passed.get(courseId);
    if (!record) return false;
    const threshold = minGrade ? new Decimal(minGrade) : this.passingThreshold();
    return record.bestValue.lessThanOrEqualTo(threshold);
  }

  /**
   * Full curriculum evaluation for a student/term, used by the enrollment
   * planner UI. `requestedCourseIds` (optional) lets COREQUISITE/CONCURRENT
   * edges be satisfied by the batch being reserved.
   */
  async evaluate(
    studentId: string,
    termId: string,
    requestedCourseIds: Set<string> = new Set(),
  ): Promise<EligibilityResult> {
    const state = await this.loadState(studentId, termId);

    const curriculumEntries = await this.prisma.curriculumCourse.findMany({
      where: { curriculumVersionId: state.curriculumVersionId },
      include: { course: true },
      orderBy: [{ yearLevel: 'asc' }, { termNo: 'asc' }],
    });
    const curriculumCourseIds = new Set(curriculumEntries.map((entry) => entry.courseId));
    const courseIndex = new Map(curriculumEntries.map((entry) => [entry.courseId, entry]));
    const allCourseIds = new Set([...curriculumCourseIds, ...state.requisites.map((edge) => edge.requiredCourseId)]);
    const courses = await this.prisma.course.findMany({ where: { id: { in: [...allCourseIds] } } });
    const courseById = new Map(courses.map((course) => [course.id, course]));

    const requisitesInCurriculum = state.requisites.filter(
      (edge) => curriculumCourseIds.has(edge.courseId) || curriculumCourseIds.has(edge.requiredCourseId),
    );
    const unlocks = unlockCounts([...curriculumCourseIds], requisitesInCurriculum);

    const eligible: EligibilityResult['eligible'] = [];
    const blocked: EligibilityBlock[] = [];
    const alreadyPassed: EligibilityResult['alreadyPassed'] = [];

    for (const entry of curriculumEntries) {
      const courseId = entry.courseId;
      if (this.isPassed(state, courseId, null)) {
        alreadyPassed.push({
          courseId,
          code: entry.course.code,
          title: entry.course.title,
          bestValue: state.passed.get(courseId)!.bestValue.toFixed(2),
        });
        continue;
      }

      const incoming = state.requisites.filter((edge) => edge.courseId === courseId);
      const missingPrerequisites: EligibilityBlock['missingPrerequisites'] = [];
      let requiresCoEnrollment = false;

      for (const edge of incoming) {
        const requiredCourse = courseById.get(edge.requiredCourseId);
        if (edge.type === 'PREREQUISITE') {
          if (!this.isPassed(state, edge.requiredCourseId, null)) {
            missingPrerequisites.push({
              courseId: edge.requiredCourseId,
              code: requiredCourse?.code ?? edge.requiredCourseId,
              minGrade: null,
              requiredType: edge.type,
            });
          }
        } else {
          const satisfied =
            this.isPassed(state, edge.requiredCourseId, null) ||
            state.enrolledCourseIds.has(edge.requiredCourseId) ||
            requestedCourseIds.has(edge.requiredCourseId) ||
            (edge.type === 'COREQUISITE' && state.waitlistedCourseIds.has(edge.requiredCourseId));
          if (!satisfied) {
            missingPrerequisites.push({
              courseId: edge.requiredCourseId,
              code: requiredCourse?.code ?? edge.requiredCourseId,
              minGrade: null,
              requiredType: edge.type,
            });
            requiresCoEnrollment = true;
          }
        }
      }

      if (missingPrerequisites.length > 0) {
        blocked.push({
          courseId,
          code: entry.course.code,
          title: entry.course.title,
          reason: requiresCoEnrollment && missingPrerequisites.every((edge) => edge.requiredType !== 'PREREQUISITE')
            ? 'REQUIRES_COENROLLMENT'
            : 'MISSING_PREREQUISITES',
          missingPrerequisites,
        });
        continue;
      }

      eligible.push({
        courseId,
        code: entry.course.code,
        title: entry.course.title,
        lectureUnits: entry.course.lectureUnits,
        labUnits: entry.course.labUnits,
        yearLevel: entry.yearLevel,
        termNo: entry.termNo,
        unlocksCount: unlocks.get(courseId) ?? 0,
      });
    }

    const consumedThisTerm: EligibilityResult['consumedThisTerm'] = [];
    const termItems = await this.prisma.enrollmentItem.findMany({
      where: { enrollment: { studentId, termId }, status: { in: ['ENROLLED', 'WAITLISTED'] } },
      include: { section: { include: { course: true } } },
    });
    for (const item of termItems) {
      consumedThisTerm.push({
        courseId: item.section.courseId,
        code: item.section.course.code,
        title: item.section.course.title,
        status: item.status as 'ENROLLED' | 'WAITLISTED',
        sectionId: item.sectionId,
      });
    }

    void courseIndex;
    return {
      studentId,
      termId,
      curriculumVersionId: state.curriculumVersionId,
      eligible,
      blocked,
      alreadyPassed,
      consumedThisTerm,
    };
  }

  /**
   * Reservation-time guard. Throws PREREQUISITE_NOT_MET / COREQUISITE_NOT_MET
   * with the exact missing course IDs (BSL-201).
   */
  async assertReservationEligible(studentId: string, termId: string, requestedCourseIds: Set<string>): Promise<StudentAcademicState> {
    const state = await this.loadState(studentId, termId);
    const requested = [...requestedCourseIds];

    const prerequisiteViolations: Array<{ courseId: string; missing: string[] }> = [];
    const corequisiteViolations: Array<{ courseId: string; missing: string[] }> = [];

    for (const courseId of requested) {
      const incoming = state.requisites.filter((edge) => edge.courseId === courseId);
      const missingPrereq: string[] = [];
      const missingCoreq: string[] = [];

      for (const edge of incoming) {
        if (edge.type === 'PREREQUISITE') {
          if (!this.isPassed(state, edge.requiredCourseId, null)) missingPrereq.push(edge.requiredCourseId);
        } else {
          const satisfied =
            this.isPassed(state, edge.requiredCourseId, null) ||
            state.enrolledCourseIds.has(edge.requiredCourseId) ||
            requestedCourseIds.has(edge.requiredCourseId) ||
            (edge.type === 'COREQUISITE' && state.waitlistedCourseIds.has(edge.requiredCourseId));
          if (!satisfied) missingCoreq.push(edge.requiredCourseId);
        }
      }

      if (missingPrereq.length > 0) prerequisiteViolations.push({ courseId, missing: missingPrereq });
      if (missingCoreq.length > 0) corequisiteViolations.push({ courseId, missing: missingCoreq });
    }

    if (prerequisiteViolations.length > 0) {
      throw new AppError(ErrorCodes.PREREQUISITE_NOT_MET, 'One or more requested courses have unmet prerequisites.', {
        meta: { violations: prerequisiteViolations },
      });
    }
    if (corequisiteViolations.length > 0) {
      throw new AppError(
        ErrorCodes.COREQUISITE_NOT_MET,
        'One or more requested courses require co-enrollment with a corequisite/concurrent course.',
        { meta: { violations: corequisiteViolations } },
      );
    }
    return state;
  }
}
