import type { PrismaClient, School, SchoolStatus } from '@prisma/client';
import type { Env } from '../../config/env';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import { requireTenantSchoolId } from '../../core/tenant/context';
import type { AuditService } from '../audit/audit.service';

/**
 * School configuration surface (Phase 1b).
 *
 * `resolvePolicy()` is the single source of truth for per-school academic
 * policy: services (eligibility, enrollment, fees, grading, INC) read it in
 * place of the legacy environment values. When a school has no SchoolPolicy
 * row yet, the environment defaults apply — preserving single-tenant parity.
 */

export interface ResolvedSchoolPolicy {
  maxAcademicUnits: number;
  passingGradeMax: string;
  incDefaultGrade: string;
  incCompletionDays: number;
  deansListerMaxGwa: string;
  honorsSummaMax: string;
  honorsMagnaMax: string;
  honorsCumLaudeMax: string;
  currency: string;
}

export interface SchoolProfile {
  id: string;
  code: string;
  name: string;
  status: SchoolStatus;
  address: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  logoUrl: string | null;
  brandColor: string | null;
}

export interface SchoolView {
  school: SchoolProfile;
  policy: ResolvedSchoolPolicy;
  policySource: 'school' | 'env';
}

export interface UpdateSchoolProfileInput {
  name?: string;
  address?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  website?: string | null;
  logoUrl?: string | null;
  brandColor?: string | null;
}

export interface UpdateSchoolPolicyInput {
  maxAcademicUnits?: number;
  passingGradeMax?: string;
  incDefaultGrade?: string;
  incCompletionDays?: number;
  deansListerMaxGwa?: string;
  honorsSummaMax?: string;
  honorsMagnaMax?: string;
  honorsCumLaudeMax?: string;
  currency?: string;
}

type PolicyEnv = Pick<
  Env,
  | 'passingGradeMax'
  | 'incCompletionDays'
  | 'incDefaultGrade'
  | 'deansListerMaxGwa'
  | 'honorsSummaMax'
  | 'honorsMagnaMax'
  | 'honorsCumLaudeMax'
  | 'maxAcademicUnits'
  | 'currency'
>;

function pickDefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export class SchoolService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly config: PolicyEnv,
  ) {}

  /** Effective academic policy for the current tenant (env fallback). */
  async resolvePolicy(): Promise<ResolvedSchoolPolicy> {
    const schoolId = requireTenantSchoolId();
    const row = await this.prisma.schoolPolicy.findUnique({ where: { schoolId } });
    return row ? this.fromRow(row) : this.envDefaults();
  }

  async getProfile(): Promise<SchoolView> {
    const schoolId = requireTenantSchoolId();
    const [school, policyRow] = await Promise.all([
      this.prisma.school.findUnique({ where: { id: schoolId } }),
      this.prisma.schoolPolicy.findUnique({ where: { schoolId } }),
    ]);
    if (!school) throw new AppError(ErrorCodes.NOT_FOUND, 'School not found.');
    return {
      school: this.toProfile(school),
      policy: policyRow ? this.fromRow(policyRow) : this.envDefaults(),
      policySource: policyRow ? 'school' : 'env',
    };
  }

  async updateProfile(actorId: string, input: UpdateSchoolProfileInput): Promise<SchoolView> {
    const schoolId = requireTenantSchoolId();
    const data = pickDefined(input);
    const fields = Object.keys(data);
    if (fields.length === 0) return this.getProfile();

    await this.prisma.$transaction(async (tx) => {
      const school = await tx.school.findUnique({ where: { id: schoolId } });
      if (!school) throw new AppError(ErrorCodes.NOT_FOUND, 'School not found.');
      await tx.school.update({ where: { id: schoolId }, data });
      await this.audit.append(tx, {
        actorId,
        action: 'school.profile.updated',
        resourceType: 'school',
        resourceId: schoolId,
        payload: { fields, values: data },
      });
    });
    return this.getProfile();
  }

  async updatePolicy(actorId: string, input: UpdateSchoolPolicyInput): Promise<SchoolView> {
    const schoolId = requireTenantSchoolId();
    const data = pickDefined(input);
    const fields = Object.keys(data);
    if (fields.length === 0) return this.getProfile();

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.schoolPolicy.findUnique({ where: { schoolId } });
      if (existing) {
        await tx.schoolPolicy.update({ where: { schoolId }, data });
      } else {
        await tx.schoolPolicy.create({ data: { schoolId, ...data } });
      }
      await this.audit.append(tx, {
        actorId,
        action: 'school.policy.updated',
        resourceType: 'school_policy',
        resourceId: schoolId,
        payload: { fields, values: data },
      });
    });
    return this.getProfile();
  }

  private fromRow(row: {
    maxAcademicUnits: number;
    passingGradeMax: { toFixed(digits: number): string };
    incDefaultGrade: { toFixed(digits: number): string };
    incCompletionDays: number;
    deansListerMaxGwa: { toFixed(digits: number): string };
    honorsSummaMax: { toFixed(digits: number): string };
    honorsMagnaMax: { toFixed(digits: number): string };
    honorsCumLaudeMax: { toFixed(digits: number): string };
    currency: string;
  }): ResolvedSchoolPolicy {
    return {
      maxAcademicUnits: row.maxAcademicUnits,
      passingGradeMax: row.passingGradeMax.toFixed(2),
      incDefaultGrade: row.incDefaultGrade.toFixed(2),
      incCompletionDays: row.incCompletionDays,
      deansListerMaxGwa: row.deansListerMaxGwa.toFixed(2),
      honorsSummaMax: row.honorsSummaMax.toFixed(2),
      honorsMagnaMax: row.honorsMagnaMax.toFixed(2),
      honorsCumLaudeMax: row.honorsCumLaudeMax.toFixed(2),
      currency: row.currency,
    };
  }

  private envDefaults(): ResolvedSchoolPolicy {
    return {
      maxAcademicUnits: this.config.maxAcademicUnits,
      passingGradeMax: this.config.passingGradeMax,
      incDefaultGrade: this.config.incDefaultGrade,
      incCompletionDays: this.config.incCompletionDays,
      deansListerMaxGwa: this.config.deansListerMaxGwa,
      honorsSummaMax: this.config.honorsSummaMax,
      honorsMagnaMax: this.config.honorsMagnaMax,
      honorsCumLaudeMax: this.config.honorsCumLaudeMax,
      currency: this.config.currency,
    };
  }

  private toProfile(school: School): SchoolProfile {
    return {
      id: school.id,
      code: school.code,
      name: school.name,
      status: school.status,
      address: school.address,
      contactEmail: school.contactEmail,
      contactPhone: school.contactPhone,
      website: school.website,
      logoUrl: school.logoUrl,
      brandColor: school.brandColor,
    };
  }
}
