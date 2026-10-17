import type { PrismaClient } from '@prisma/client';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { Clock } from '../../core/time/clock';

/**
 * Instructor ABAC guard (BSL-006).
 * Grade input allowed iff:
 *   section.instructorId === user.id
 *   AND term.status === 'GRADING'
 *   AND now ∈ [term.gradingStartAt, term.gradingEndAt]
 */
export class SectionAccessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
  ) {}

  async assertInstructorCanGrade(userId: string, sectionId: string) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      include: { term: true },
    });
    if (!section) throw new AppError(ErrorCodes.NOT_FOUND, 'Section not found.');

    if (section.instructorId !== userId) {
      throw new AppError(ErrorCodes.FORBIDDEN, 'You are not the assigned instructor of this section.', {
        meta: { sectionId, assignedInstructorId: section.instructorId },
      });
    }
    if (section.term.status !== 'GRADING') {
      throw new AppError(
        ErrorCodes.INVALID_TERM_STATUS,
        `Grades can only be encoded while the term is in GRADING (current: ${section.term.status}).`,
      );
    }
    const now = this.clock.now();
    if (now < section.term.gradingStartAt || now > section.term.gradingEndAt) {
      throw new AppError(
        ErrorCodes.INSTRUCTOR_WINDOW_CLOSED,
        `The grading window is ${section.term.gradingStartAt.toISOString()} – ${section.term.gradingEndAt.toISOString()}.`,
        { meta: { gradingStartAt: section.term.gradingStartAt, gradingEndAt: section.term.gradingEndAt, now } },
      );
    }
    return section;
  }
}
