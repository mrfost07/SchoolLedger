import type { HoldType, StudentHold } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { requireTenantSchoolId } from '../../core/tenant/context';
import type { AuditService } from '../audit/audit.service';
import type { Db } from '../../infra/prisma';

export interface ClearanceOptions {
  /** True for official document issuance: DOCUMENTARY holds also block. */
  forOfficialDocument?: boolean;
}

/**
 * Student clearance guard (BSL-007).
 * Enrollment is blocked by FINANCIAL and DISCIPLINARY holds; official document
 * issuance additionally honors DOCUMENTARY holds. Holds are time-bounded.
 */
export class HoldsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async activeHolds(studentId: string, options: ClearanceOptions = {}, db: Db = this.prisma): Promise<StudentHold[]> {
    const types: HoldType[] = options.forOfficialDocument
      ? ['FINANCIAL', 'DISCIPLINARY', 'DOCUMENTARY']
      : ['FINANCIAL', 'DISCIPLINARY'];
    const now = new Date();
    return db.studentHold.findMany({
      where: {
        studentId,
        type: { in: types },
        liftedAt: null,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  async assertClearance(studentId: string, options: ClearanceOptions = {}, db: Db = this.prisma): Promise<void> {
    const holds = await this.activeHolds(studentId, options, db);
    if (holds.length > 0) {
      throw new AppError(ErrorCodes.STUDENT_CLEARANCE_HOLD, 'The student has active holds that block this action.', {
        meta: {
          holds: holds.map((hold) => ({ id: hold.id, type: hold.type, reason: hold.reason, startsAt: hold.startsAt })),
        },
      });
    }
  }

  async createHold(
    actorId: string,
    input: { studentId: string; type: HoldType; reason: string; endsAt?: Date },
  ): Promise<StudentHold> {
    const student = await this.prisma.user.findUnique({
      where: { id: input.studentId },
      include: { profile: true },
    });
    if (!student || !student.profile) {
      throw new AppError(ErrorCodes.STUDENT_PROFILE_REQUIRED, 'Target user has no student profile.');
    }

    return this.prisma.$transaction(async (tx) => {
      const hold = await tx.studentHold.create({
        data: {
          schoolId: requireTenantSchoolId(),
          studentId: input.studentId,
          type: input.type,
          reason: input.reason,
          endsAt: input.endsAt ?? null,
          createdBy: actorId,
        },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'iam.hold.created',
        resourceType: 'student_hold',
        resourceId: hold.id,
        payload: { studentId: input.studentId, type: input.type, reason: input.reason },
      });
      return hold;
    });
  }

  async liftHold(actorId: string, holdId: string): Promise<StudentHold> {
    const hold = await this.prisma.studentHold.findUnique({ where: { id: holdId } });
    if (!hold) throw new AppError(ErrorCodes.NOT_FOUND, 'Hold not found.');
    if (hold.liftedAt) throw new AppError(ErrorCodes.CONFLICT, 'Hold is already lifted.');

    return this.prisma.$transaction(async (tx) => {
      const lifted = await tx.studentHold.update({ where: { id: holdId }, data: { liftedAt: new Date() } });
      await this.audit.append(tx, {
        actorId,
        action: 'iam.hold.lifted',
        resourceType: 'student_hold',
        resourceId: holdId,
        payload: { studentId: hold.studentId, type: hold.type },
      });
      return lifted;
    });
  }

  async listHolds(studentId: string, includeInactive = false): Promise<StudentHold[]> {
    return this.prisma.studentHold.findMany({
      where: { studentId, ...(includeInactive ? {} : { liftedAt: null }) },
      orderBy: { startsAt: 'desc' },
    });
  }
}
