import { Type } from '@sinclair/typebox';
import type { AppServer } from '../../core/http/server-types';
import type { AppContext } from '../../context';
import { requireAuth, requireRoles } from '../../core/http/auth';
import { errorResponses, IdempotencyKeyHeader, Uuid } from '../../core/http/schemas';
import { withIdempotency } from '../../core/http/idempotency';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { EligibilityService } from './eligibility.service';
import type { EnrollmentService } from './enrollment.service';
import type { FeesService } from './fees.service';
import type { WaitlistPromotionService } from './waitlist.worker';
import {
  AssessmentSchema,
  EligibilityResponseSchema,
  EnrollmentItemSchema,
  EnrollmentSchema,
  ReserveResponseSchema,
} from './enrollment.schemas';

export interface EnrollmentServices {
  eligibility: EligibilityService;
  enrollments: EnrollmentService;
  fees: FeesService;
  waitlist: WaitlistPromotionService;
}

export function registerEnrollmentRoutes(app: AppServer, ctx: AppContext, services: EnrollmentServices): void {
  const { eligibility, enrollments, fees, waitlist } = services;

  const resolveStudentId = (request: Parameters<typeof requireAuth>[0], requestedStudentId?: string): string => {
    const auth = requireAuth(request, ctx.config);
    const isStaff = auth.roles.some((role) => ['REGISTRAR', 'ADMIN'].includes(role));
    if (requestedStudentId && requestedStudentId !== auth.userId) {
      if (!isStaff) throw new AppError(ErrorCodes.FORBIDDEN, 'Only REGISTRAR/ADMIN may act on behalf of another student.');
      return requestedStudentId;
    }
    return auth.userId;
  };

  app.get(
    '/api/v1/enrollments/eligibility',
    {
      config: { permission: ['enrollment.view.self', 'enrollment.view.any'] },
      schema: {
        tags: ['Enrollment'],
        summary: 'Curriculum eligibility: eligible / blocked (with missing prerequisite IDs) / already passed / consumed courses.',
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({ termId: Uuid, studentId: Type.Optional(Uuid) }),
        response: { 200: EligibilityResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const studentId = resolveStudentId(request, request.query.studentId);
      return eligibility.evaluate(studentId, request.query.termId);
    },
  );

  app.post(
    '/api/v1/enrollments/reserve',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' }, permission: ['enrollment.reserve', 'enrollment.manage'] },
      schema: {
        tags: ['Enrollment'],
        summary: 'Atomic multi-section slot reservation. Idempotency-Key required.',
        description:
          'Admission control runs in Redis (atomic Lua: capacity + schedule overlap), the authoritative commit runs in Postgres with deterministic row locks (section id ASC). Capacity can never be exceeded (INV-1).',
        security: [{ bearerAuth: [] }],
        headers: Type.Object({ 'idempotency-key': IdempotencyKeyHeader }),
        body: Type.Object({
          termId: Uuid,
          sectionIds: Type.Array(Uuid, { minItems: 1, maxItems: 12 }),
          allowOverload: Type.Optional(
            Type.Boolean({ description: 'REGISTRAR/ADMIN only: allow exceeding the max academic unit load' }),
          ),
        }),
        response: { 201: ReserveResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = requireRoles(request, ctx.config, 'STUDENT', 'REGISTRAR', 'ADMIN');
      const isStaff = auth.roles.some((role) => ['REGISTRAR', 'ADMIN'].includes(role));
      if (request.body.allowOverload && !isStaff) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Only REGISTRAR/ADMIN may override the academic load limit.');
      }
      const result = await withIdempotency(ctx, request, reply, true, async () =>
        enrollments.reserve(auth.userId, {
          termId: request.body.termId,
          sectionIds: request.body.sectionIds,
          allowOverload: request.body.allowOverload ?? false,
        }),
      );
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/api/v1/enrollments/drop',
    {
      config: { permission: ['enrollment.drop', 'enrollment.manage'] },
      schema: {
        tags: ['Enrollment'],
        summary: 'Drop an enrollment item (or leave a waitlist). Triggers waitlist auto-promotion when a slot frees up.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({ itemId: Uuid }),
        response: {
          200: Type.Object({ item: EnrollmentItemSchema, promoted: Type.Boolean() }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      const result = await enrollments.dropItem(auth.userId, request.body.itemId);
      return { item: result.item, promoted: result.promoted };
    },
  );

  app.post(
    '/api/v1/enrollments/waitlist',
    {
      config: { permission: ['enrollment.waitlist.join', 'enrollment.manage'] },
      schema: {
        tags: ['Enrollment'],
        summary: 'Join the FIFO waitlist of a full section.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({ termId: Uuid, sectionId: Uuid }),
        response: { 201: EnrollmentItemSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = requireRoles(request, ctx.config, 'STUDENT', 'REGISTRAR', 'ADMIN');
      const item = await enrollments.joinWaitlist(auth.userId, request.body.termId, request.body.sectionId);
      return reply.status(201).send(item);
    },
  );

  app.get(
    '/api/v1/enrollments',
    {
      config: { permission: ['enrollment.view.self', 'enrollment.view.any'] },
      schema: {
        tags: ['Enrollment'],
        summary: 'Current enrollment for a term (items, sections, assessment).',
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({ termId: Uuid, studentId: Type.Optional(Uuid) }),
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async (request) => {
      const studentId = resolveStudentId(request, request.query.studentId);
      return enrollments.getEnrollment(studentId, request.query.termId);
    },
  );

  app.get(
    '/api/v1/enrollments/sections/:sectionId/waitlist',
    {
      config: { permission: 'enrollment.view.any' },
      schema: {
        tags: ['Enrollment'],
        summary: 'FIFO waitlist of a section. REGISTRAR/ADMIN/INSTRUCTOR.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        querystring: Type.Object({ termId: Uuid }),
        response: { 200: Type.Array(Type.Any()), ...errorResponses },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN', 'INSTRUCTOR');
      return enrollments.listWaitlist(request.query.termId, request.params.sectionId);
    },
  );

  app.post(
    '/api/v1/enrollments/sections/:sectionId/promote',
    {
      config: { permission: 'enrollment.manage' },
      schema: {
        tags: ['Enrollment'],
        summary: 'Manually run waitlist promotion for a section (worker does this automatically on drops). REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        body: Type.Object({ termId: Uuid }),
        response: {
          200: Type.Object({
            sectionId: Uuid,
            promoted: Type.Array(Type.Object({ itemId: Uuid, studentId: Uuid })),
            removed: Type.Array(Type.Object({ itemId: Uuid, studentId: Uuid, reason: Type.String() })),
            stoppedBecause: Type.String(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN');
      return waitlist.promote(request.body.termId, request.params.sectionId);
    },
  );

  app.get(
    '/api/v1/enrollments/:enrollmentId/assessment',
    {
      config: { permission: ['fees.view.self', 'fees.view.any'] },
      schema: {
        tags: ['Enrollment'],
        summary: 'Immutable tuition assessment breakdown for an enrollment.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ enrollmentId: Uuid }),
        response: { 200: AssessmentSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      const enrollment = await ctx.prisma.enrollment.findUnique({ where: { id: request.params.enrollmentId } });
      if (!enrollment) throw new AppError(ErrorCodes.NOT_FOUND, 'Enrollment not found.');
      const isStaff = auth.roles.some((role) => ['REGISTRAR', 'ADMIN', 'CASHIER'].includes(role));
      if (!isStaff && enrollment.studentId !== auth.userId) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Not your enrollment.');
      }
      const assessment = await ctx.prisma.tuitionAssessment.findUnique({ where: { enrollmentId: request.params.enrollmentId } });
      if (!assessment) throw new AppError(ErrorCodes.NOT_FOUND, 'No assessment computed for this enrollment.');
      return assessment;
    },
  );

  app.post(
    '/api/v1/enrollments/assessments/:assessmentId/pay',
    {
      config: { permission: 'fees.collect' },
      schema: {
        tags: ['Enrollment'],
        summary: 'Mark an assessment as PAID (freezes the breakdown). CASHIER/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ assessmentId: Uuid }),
        response: { 200: AssessmentSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'CASHIER', 'ADMIN');
      return fees.markPaid(auth.userId, request.params.assessmentId);
    },
  );
}
