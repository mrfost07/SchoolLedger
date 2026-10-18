import { Decimal } from 'decimal.js';
import type { PrismaClient, TuitionAssessment } from '@prisma/client';
import type { Env } from '../../config/env';
import { canonicalJson, sha256Hex } from '../../core/crypto/hash';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { requireTenantSchoolId } from '../../core/tenant/context';
import type { AuditService } from '../audit/audit.service';

interface LineItem {
  code: string;
  name: string;
  category: 'TUITION' | 'LAB' | 'MISC' | 'OTHER';
  amount: string;
  detail?: string;
}

interface Discount {
  code: string;
  name: string;
  percent: string;
  amount: string;
}

export interface FeeBreakdown {
  currency: string;
  units: { lecture: number; lab: number; total: number };
  lineItems: LineItem[];
  discounts: Discount[];
  subtotal: string;
  total: string;
}

/**
 * Fee assessment calculator (BSL-205 / BSL-101).
 * Deterministic: identical inputs produce an identical breakdown and hash.
 * Monetary arithmetic uses decimal.js with ROUND_HALF_UP at 2 dp.
 */
export class FeesService {
  private readonly money = Decimal.clone({ precision: 20 });

  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly config: Pick<Env, 'currency'>,
  ) {}

  private moneyStr(value: Decimal): string {
    return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }

  async computeBreakdown(enrollmentId: string): Promise<{ breakdown: FeeBreakdown; snapshotHash: string }> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        student: { include: { profile: true, scholarships: true } },
        items: {
          where: { status: 'ENROLLED' },
          include: { section: { include: { course: true } } },
        },
      },
    });
    if (!enrollment) throw new AppError(ErrorCodes.NOT_FOUND, 'Enrollment not found.');

    const profile = enrollment.student.profile;
    const programId = profile?.programId ?? null;
    const now = new Date();

    const feeDefinitions = await this.prisma.feeDefinition.findMany({
      where: {
        activeFrom: { lte: now },
        OR: [{ activeTo: null }, { activeTo: { gt: now } }],
        AND: [
          {
            OR: [{ programId: null }, ...(programId ? [{ programId }] : [])],
          },
        ],
      },
    });

    // Program-specific definitions override global ones with the same code.
    const byCode = new Map<string, (typeof feeDefinitions)[number]>();
    for (const definition of feeDefinitions) {
      const existing = byCode.get(definition.code);
      if (!existing || (definition.programId && !existing.programId)) {
        byCode.set(definition.code, definition);
      }
    }
    const definitions = [...byCode.values()];

    const tuitionDef = definitions.find((definition) => definition.category === 'TUITION' && definition.perUnit);
    const labDef = definitions.find((definition) => definition.category === 'LAB' && definition.perUnit);
    const flatDefinitions = definitions.filter((definition) => !definition.perUnit && definition.category !== 'TUITION' && definition.category !== 'LAB');

    let lectureUnits = 0;
    let labUnits = 0;
    for (const item of enrollment.items) {
      lectureUnits += item.section.course.lectureUnits;
      labUnits += item.section.course.labUnits;
    }

    const lineItems: LineItem[] = [];
    let subtotal = new this.money(0);

    if (tuitionDef && lectureUnits > 0) {
      const amount = new this.money(tuitionDef.amount.toString()).times(lectureUnits);
      subtotal = subtotal.plus(amount);
      lineItems.push({
        code: tuitionDef.code,
        name: tuitionDef.name,
        category: 'TUITION',
        amount: this.moneyStr(amount),
        detail: `${lectureUnits} lecture unit(s) × ${this.moneyStr(new this.money(tuitionDef.amount.toString()))}`,
      });
    }

    if (labDef && labUnits > 0) {
      const amount = new this.money(labDef.amount.toString()).times(labUnits);
      subtotal = subtotal.plus(amount);
      lineItems.push({
        code: labDef.code,
        name: labDef.name,
        category: 'LAB',
        amount: this.moneyStr(amount),
        detail: `${labUnits} laboratory unit(s) × ${this.moneyStr(new this.money(labDef.amount.toString()))}`,
      });
    }

    for (const definition of flatDefinitions) {
      const amount = new this.money(definition.amount.toString());
      subtotal = subtotal.plus(amount);
      lineItems.push({
        code: definition.code,
        name: definition.name,
        category: definition.category as LineItem['category'],
        amount: this.moneyStr(amount),
      });
    }

    const activeScholarships = enrollment.student.scholarships.filter(
      (scholarship) => scholarship.activeFrom <= now && (!scholarship.activeTo || scholarship.activeTo > now),
    );
    // Only the single best discount applies (no stacking) — see ledger R-05.
    const best = activeScholarships.reduce<(typeof activeScholarships)[number] | null>((acc, scholarship) => {
      if (!acc) return scholarship;
      return new Decimal(scholarship.discountPercent.toString()).greaterThan(new Decimal(acc.discountPercent.toString())) ? scholarship : acc;
    }, null);

    const discounts: Discount[] = [];
    let total = subtotal;
    if (best) {
      const percent = new Decimal(best.discountPercent.toString());
      const discountAmount = subtotal.times(percent).dividedBy(100);
      total = subtotal.minus(discountAmount);
      discounts.push({
        code: best.code,
        name: best.name,
        percent: percent.toFixed(2),
        amount: this.moneyStr(discountAmount),
      });
    }

    const breakdown: FeeBreakdown = {
      currency: this.config.currency,
      units: { lecture: lectureUnits, lab: labUnits, total: lectureUnits + labUnits },
      lineItems,
      discounts,
      subtotal: this.moneyStr(subtotal),
      total: this.moneyStr(total),
    };

    return { breakdown, snapshotHash: sha256Hex(canonicalJson(breakdown)) };
  }

  /**
   * Computes and persists the immutable assessment for an enrollment.
   * Idempotent: re-computing an unchanged enrollment returns the stored row.
   * A changed enrollment voids the previous ASSESSED row and creates a new one;
   * PAID assessments are frozen (adjustments are out of scope — see ledger).
   */
  async assess(actorId: string | null, enrollmentId: string): Promise<TuitionAssessment> {
    const { breakdown, snapshotHash } = await this.computeBreakdown(enrollmentId);
    const existing = await this.prisma.tuitionAssessment.findUnique({ where: { enrollmentId } });

    if (existing) {
      if (existing.snapshotHash === snapshotHash) return existing;
      if (existing.status === 'PAID') {
        throw new AppError(ErrorCodes.CONFLICT, 'Assessment is already PAID; financial adjustments require the cashier workflow.');
      }
      if (existing.status === 'ASSESSED') {
        await this.prisma.tuitionAssessment.update({ where: { id: existing.id }, data: { status: 'VOID' } });
      }
    }

    const total = new Decimal(breakdown.total);
    return this.prisma.$transaction(async (tx) => {
      const assessment = await tx.tuitionAssessment.create({
        data: {
          schoolId: requireTenantSchoolId(),
          enrollmentId,
          currency: breakdown.currency,
          breakdown: JSON.parse(canonicalJson(breakdown)) as object,
          totalAmount: total.toFixed(2),
          snapshotHash,
        },
      });
      await this.audit.append(tx, {
        actorId,
        action: 'enrollment.assessment.computed',
        resourceType: 'tuition_assessment',
        resourceId: assessment.id,
        payload: { enrollmentId, total: breakdown.total, snapshotHash },
      });
      return assessment;
    });
  }

  async markPaid(actorId: string, assessmentId: string): Promise<TuitionAssessment> {
    const assessment = await this.prisma.tuitionAssessment.findUnique({ where: { id: assessmentId } });
    if (!assessment) throw new AppError(ErrorCodes.NOT_FOUND, 'Assessment not found.');
    if (assessment.status === 'PAID') return assessment;
    if (assessment.status === 'VOID') throw new AppError(ErrorCodes.CONFLICT, 'Cannot pay a voided assessment.');

    return this.prisma.$transaction(async (tx) => {
      const flipped = await tx.tuitionAssessment.updateMany({
        where: { id: assessmentId, status: 'ASSESSED' },
        data: { status: 'PAID', paidAt: new Date() },
      });
      const paid = await tx.tuitionAssessment.findUniqueOrThrow({ where: { id: assessmentId } });
      if (flipped.count !== 1) {
        // A concurrent payment won the race; return it without a duplicate audit row.
        if (paid.status === 'PAID') return paid;
        throw new AppError(ErrorCodes.CONFLICT, 'Assessment cannot be paid in its current state.');
      }
      await this.audit.append(tx, {
        actorId,
        action: 'enrollment.assessment.paid',
        resourceType: 'tuition_assessment',
        resourceId: assessmentId,
        payload: { enrollmentId: assessment.enrollmentId, total: assessment.totalAmount.toString() },
      });
      return paid;
    });
  }
}
