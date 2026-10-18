import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../errors/taxonomy';
import { getTenantStore } from './context';

/**
 * Tenant-table catalog: Prisma client model name -> the column that carries
 * the owning school. Every model listed here is enforced by
 * `tenantExtension`; unlisted models are platform-global (User identity,
 * permission registry, role templates).
 */
export const TENANT_MODELS: Readonly<Record<string, string>> = {
  School: 'id',
  SchoolPolicy: 'schoolId',
  Membership: 'schoolId',
  RoleAssignment: 'schoolId',
  Invitation: 'schoolId',
  StudentProfile: 'schoolId',
  StudentHold: 'schoolId',
  AuditLog: 'schoolId',
  IdempotencyKey: 'schoolId',
  Department: 'schoolId',
  Program: 'schoolId',
  CurriculumVersion: 'schoolId',
  Course: 'schoolId',
  CurriculumCourse: 'schoolId',
  CourseRequisite: 'schoolId',
  AcademicTerm: 'schoolId',
  Room: 'schoolId',
  Section: 'schoolId',
  SectionSchedule: 'schoolId',
  Enrollment: 'schoolId',
  EnrollmentItem: 'schoolId',
  FeeDefinition: 'schoolId',
  Scholarship: 'schoolId',
  TuitionAssessment: 'schoolId',
  GradeSheet: 'schoolId',
  GradeLedgerEntry: 'schoolId',
  GradeRectification: 'schoolId',
  DocumentRequest: 'schoolId',
  DocumentDownloadEvent: 'schoolId',
};

type LooseArgs = Record<string, unknown>;

function mergeWhere(where: unknown, field: string, schoolId: string): LooseArgs {
  if (where === undefined || where === null) return { [field]: schoolId };
  return { AND: [where, { [field]: schoolId }] };
}

/**
 * Unique-where operations (update/delete) require the unique field at the top
 * level, so the tenant column is inlined instead of AND-merged. A `where` that
 * already pins a different school is rejected outright.
 */
function mergeUniqueWhere(where: unknown, field: string, schoolId: string, model: string): LooseArgs {
  const base = (where ?? {}) as LooseArgs;
  assertSchoolValue(base, field, schoolId, model);
  return { ...base, [field]: schoolId };
}

function assertSchoolValue(data: LooseArgs, field: string, schoolId: string, model: string): void {
  const existing = data[field];
  if (existing !== undefined && existing !== schoolId) {
    throw new AppError(
      ErrorCodes.FORBIDDEN,
      `${model}.${field} cannot be changed or set to another school from this context.`,
    );
  }
}

/**
 * Fail-closed tenant scoping extension (ADR-0001, Phase 1a interim enforcement).
 *
 * - Tenant models are only reachable inside an explicit tenant (school) or
 *   system context frame; otherwise the query throws TENANT_CONTEXT_MISSING.
 * - In tenant context every filter is AND-merged with `schoolId = ctx.school`
 *   and every write gets the owning school injected.
 * - `findUnique` cannot carry extra filter fields, so results are
 *   post-verified and nulled/thrown when they belong to another school.
 * - System context passes through untouched (login/session resolution, seeds,
 *   ops); callers own the scoping decision there.
 *
 * Raw SQL ($queryRaw/$executeRaw) is NOT intercepted — raw call sites must
 * scope themselves (see audit advisory locks and capacity gates).
 */
export const tenantExtension = Prisma.defineExtension({
  name: 'tenant-scope',
  query: {
    $allOperations({ model, operation, args, query }) {
      const field = model ? TENANT_MODELS[model] : undefined;
      if (!field) return query(args);

      const ctx = getTenantStore();
      if (!ctx) {
        throw new AppError(
          ErrorCodes.TENANT_CONTEXT_MISSING,
          `Tenant context missing for ${model}.${operation} (wrap the call in runWithTenant/runWithSystem).`,
        );
      }
      if (ctx.system) return query(args);

      const schoolId = ctx.schoolId;
      if (!schoolId) {
        throw new AppError(
          ErrorCodes.TENANT_CONTEXT_MISSING,
          `No school bound to this context for ${model}.${operation}.`,
        );
      }

      const a = args as LooseArgs;
      switch (operation) {
        case 'findMany':
        case 'findFirst':
        case 'findFirstOrThrow':
        case 'count':
        case 'aggregate':
        case 'groupBy':
        case 'updateMany':
        case 'deleteMany': {
          a.where = mergeWhere(a.where, field, schoolId);
          return query(a);
        }
        case 'update':
        case 'delete': {
          a.where = mergeUniqueWhere(a.where, field, schoolId, model!);
          return query(a);
        }
        case 'create': {
          const data = (a.data ?? {}) as LooseArgs;
          assertSchoolValue(data, field, schoolId, model!);
          data[field] = schoolId;
          a.data = data;
          return query(a);
        }
        case 'createMany': {
          const rows = Array.isArray(a.data) ? (a.data as LooseArgs[]) : ([a.data] as LooseArgs[]);
          for (const row of rows) {
            assertSchoolValue(row, field, schoolId, model!);
            row[field] = schoolId;
          }
          a.data = Array.isArray(a.data) ? rows : rows[0];
          return query(a);
        }
        case 'upsert': {
          const create = (a.create ?? {}) as LooseArgs;
          assertSchoolValue(create, field, schoolId, model!);
          create[field] = schoolId;
          a.create = create;
          a.where = mergeUniqueWhere(a.where, field, schoolId, model!);
          const update = (a.update ?? {}) as LooseArgs;
          assertSchoolValue(update, field, schoolId, model!);
          return query(a).then((result: unknown) => verifyResult(result, field, schoolId, operation));
        }
        case 'findUnique':
        case 'findUniqueOrThrow': {
          let strip = false;
          const select = a.select as LooseArgs | undefined;
          if (select && !(field in select)) {
            a.select = { ...select, [field]: true };
            strip = true;
          }
          return query(a).then((result: unknown) => {
            const checked = verifyResult(result, field, schoolId, operation);
            if (strip && checked && typeof checked === 'object') {
              delete (checked as LooseArgs)[field];
            }
            return checked;
          });
        }
        default:
          return query(args);
      }
    },
  },
});

function verifyResult(result: unknown, field: string, schoolId: string, operation: string): unknown {
  if (result === null || result === undefined) return result;
  const row = result as LooseArgs;
  if (row[field] !== schoolId) {
    if (operation === 'findUniqueOrThrow' || operation === 'upsert') {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Record not found in this school.');
    }
    return null;
  }
  return result;
}
