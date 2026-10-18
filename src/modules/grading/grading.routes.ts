import { Type } from '@sinclair/typebox';
import type { AppServer } from '../../core/http/server-types';
import type { AppContext } from '../../context';
import { requireAuth, requireRoles, requireStepUpMfa } from '../../core/http/auth';
import { errorResponses, Uuid } from '../../core/http/schemas';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { GradingService } from './grading.service';
import type { RectificationService } from './rectification.service';
import type { IncLifecycleService } from './inc.worker';
import type { SectionAccessService } from '../academics/guards';
import type { Mark } from './state-machine';
import {
  GradeEntrySchema,
  GradeSheetSchema,
  GwaReportSchema,
  LedgerEntrySchema,
  MarkSchema,
  RectificationSchema,
} from './grading.schemas';

export interface GradingServices {
  grading: GradingService;
  rectifications: RectificationService;
  inc: IncLifecycleService;
  sectionAccess: SectionAccessService;
}

const STAFF_READERS = ['PROGRAM_CHAIR', 'REGISTRAR', 'ADMIN'] as const;

export function registerGradingRoutes(app: AppServer, ctx: AppContext, services: GradingServices): void {
  const { grading, rectifications, inc, sectionAccess } = services;

  const resolveStudentId = (request: Parameters<typeof requireAuth>[0], requested?: string): string => {
    const auth = requireAuth(request, ctx.config);
    const isStaff = auth.roles.some((role) => [...STAFF_READERS, 'INSTRUCTOR'].includes(role));
    if (requested && requested !== auth.userId) {
      if (!isStaff) throw new AppError(ErrorCodes.FORBIDDEN, 'Not allowed to read another student record.');
      return requested;
    }
    return auth.userId;
  };

  // ── Grade sheet workflow ───────────────────────────────────────────────────

  app.put(
    '/api/v1/grading/sections/:sectionId/sheet',
    {
      config: { permission: 'grading.entries.save' },
      schema: {
        tags: ['Grading'],
        summary: 'Create/update DRAFT grade entries for a section. Assigned INSTRUCTOR (or ADMIN).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        body: Type.Object({
          entries: Type.Array(
            Type.Object({ studentId: Uuid, mark: MarkSchema }),
            { minItems: 1, maxItems: 200 },
          ),
        }),
        response: { 200: GradeSheetSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'INSTRUCTOR', 'ADMIN');
      return grading.upsertDraftEntries(auth.userId, request.params.sectionId, request.body.entries);
    },
  );

  app.post(
    '/api/v1/grading/sections/:sectionId/sheet/submit',
    {
      config: { permission: 'grading.sheet.submit' },
      schema: {
        tags: ['Grading'],
        summary: 'Submit a DRAFT sheet for verification. Assigned INSTRUCTOR (or ADMIN), step-up MFA required.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        response: { 200: GradeSheetSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireStepUpMfa(request, ctx.config);
      if (!auth.roles.some((role) => ['INSTRUCTOR', 'ADMIN'].includes(role))) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Requires INSTRUCTOR or ADMIN.');
      }
      return grading.submitSheet(auth.userId, request.params.sectionId);
    },
  );

  app.get(
    '/api/v1/grading/sections/:sectionId/sheet',
    {
      config: { permission: ['grading.view.assigned', 'grading.view.any'] },
      schema: {
        tags: ['Grading'],
        summary: 'Grade sheet detail (entries + student names). Staff only; INSTRUCTOR must own the section.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        response: { 200: GradeSheetSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      const isStaff = auth.roles.some((role) => (STAFF_READERS as readonly string[]).includes(role));
      if (!isStaff) {
        if (!auth.roles.includes('INSTRUCTOR')) throw new AppError(ErrorCodes.FORBIDDEN, 'Staff only.');
        await sectionAccess.assertInstructorCanGrade(auth.userId, request.params.sectionId);
      }
      return grading.getSheet(request.params.sectionId);
    },
  );

  app.post(
    '/api/v1/grading/sheets/:sectionId/verify',
    {
      config: { permission: 'grading.sheet.verify' },
      schema: {
        tags: ['Grading'],
        summary: 'Verify a SUBMITTED sheet (PROGRAM_CHAIR/ADMIN).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        response: { 200: GradeSheetSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'PROGRAM_CHAIR', 'ADMIN');
      return grading.verifySheet(auth.userId, request.params.sectionId);
    },
  );

  app.post(
    '/api/v1/grading/sheets/:sectionId/return',
    {
      config: { permission: ['grading.sheet.verify', 'grading.sheet.post'] },
      schema: {
        tags: ['Grading'],
        summary: 'Return a SUBMITTED/VERIFIED sheet to DRAFT with a note (PROGRAM_CHAIR/REGISTRAR/ADMIN).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        body: Type.Object({ note: Type.String({ minLength: 3, maxLength: 1000 }) }),
        response: { 200: GradeSheetSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'PROGRAM_CHAIR', 'REGISTRAR', 'ADMIN');
      return grading.returnSheet(auth.userId, request.params.sectionId, request.body.note);
    },
  );

  app.post(
    '/api/v1/grading/sheets/:sectionId/post',
    {
      config: { permission: 'grading.sheet.post' },
      schema: {
        tags: ['Grading'],
        summary: 'Post a VERIFIED sheet to the immutable ledger (REGISTRAR/ADMIN, step-up MFA). This is the point of no return.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        response: { 200: GradeSheetSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireStepUpMfa(request, ctx.config);
      if (!auth.roles.some((role) => ['REGISTRAR', 'ADMIN'].includes(role))) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Posting requires REGISTRAR or ADMIN.');
      }
      return grading.postSheet(auth.userId, request.params.sectionId);
    },
  );

  // ── Reads (GWA, ledger) ────────────────────────────────────────────────────

  app.get(
    '/api/v1/grading/students/:studentId/ledger',
    {
      config: { permission: ['grading.gwa.view.self', 'grading.gwa.view.any'] },
      schema: {
        tags: ['Grading'],
        summary: 'Full grade ledger incl. superseded versions and hash chain (BSL-302).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ studentId: Uuid }),
        response: { 200: Type.Array(LedgerEntrySchema), ...errorResponses },
      },
    },
    async (request) => {
      const studentId = resolveStudentId(request, request.params.studentId);
      return grading.studentLedger(studentId);
    },
  );

  app.get(
    '/api/v1/grading/students/:studentId/gwa',
    {
      config: { permission: ['grading.gwa.view.self', 'grading.gwa.view.any'] },
      schema: {
        tags: ['Grading'],
        summary: 'Term + cumulative GWA, academic standing and latin honors (BSL-306/307/308).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ studentId: Uuid }),
        response: { 200: GwaReportSchema, ...errorResponses },
      },
    },
    async (request) => {
      const studentId = resolveStudentId(request, request.params.studentId);
      return grading.computeStudentGwa(studentId);
    },
  );

  // ── Rectifications (BSL-305) ───────────────────────────────────────────────

  app.post(
    '/api/v1/grading/rectifications',
    {
      config: { permission: 'grading.rectification.request' },
      schema: {
        tags: ['Grading'],
        summary: 'Request rectification of a POSTED grade entry. Instructor (own section) or ADMIN.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          entryId: Uuid,
          proposedValue: Type.Optional(Type.Union([Type.String({ pattern: '^[1-5](\\.\\d{1,2})?$' }), Type.Null()])),
          proposedIsInc: Type.Optional(Type.Boolean()),
          reason: Type.String({ minLength: 10, maxLength: 2000 }),
        }),
        response: { 201: RectificationSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = requireRoles(request, ctx.config, 'INSTRUCTOR', 'ADMIN');
      const rectification = await rectifications.create(auth.userId, auth.roles, {
        entryId: request.body.entryId,
        proposedValue: request.body.proposedValue ?? null,
        proposedIsInc: request.body.proposedIsInc ?? false,
        reason: request.body.reason,
      });
      return reply.status(201).send(rectification);
    },
  );

  app.post(
    '/api/v1/grading/rectifications/:id/endorse',
    {
      config: { permission: 'grading.rectification.endorse' },
      schema: {
        tags: ['Grading'],
        summary: 'Chair endorsement (PENDING → CHAIR_ENDORSED).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ note: Type.Optional(Type.String({ maxLength: 1000 })) }),
        response: { 200: RectificationSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'PROGRAM_CHAIR', 'ADMIN');
      return rectifications.endorse(auth.userId, request.params.id, request.body.note);
    },
  );

  app.post(
    '/api/v1/grading/rectifications/:id/approve',
    {
      config: { permission: 'grading.rectification.approve' },
      schema: {
        tags: ['Grading'],
        summary: 'Final approval (CHAIR_ENDORSED → APPROVED). Supersedes the old entry and appends version+1. REGISTRAR/ADMIN + step-up MFA.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ note: Type.Optional(Type.String({ maxLength: 1000 })) }),
        response: {
          200: Type.Object({ rectification: RectificationSchema, newEntryId: Uuid }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const auth = requireStepUpMfa(request, ctx.config);
      if (!auth.roles.some((role) => ['REGISTRAR', 'ADMIN'].includes(role))) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Approval requires REGISTRAR or ADMIN.');
      }
      return rectifications.approve(auth.userId, request.params.id, request.body.note);
    },
  );

  app.post(
    '/api/v1/grading/rectifications/:id/reject',
    {
      config: { permission: ['grading.rectification.approve', 'grading.rectification.endorse'] },
      schema: {
        tags: ['Grading'],
        summary: 'Reject a PENDING/CHAIR_ENDORSED rectification (Chair/Registrar/Admin).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        body: Type.Object({ note: Type.Optional(Type.String({ maxLength: 1000 })) }),
        response: { 200: RectificationSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'PROGRAM_CHAIR', 'REGISTRAR', 'ADMIN');
      return rectifications.reject(auth.userId, request.params.id, request.body.note);
    },
  );

  app.post(
    '/api/v1/grading/rectifications/:id/cancel',
    {
      config: { permission: 'grading.rectification.request' },
      schema: {
        tags: ['Grading'],
        summary: 'Cancel your own PENDING rectification request.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ id: Uuid }),
        response: { 200: RectificationSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return rectifications.cancel(auth.userId, request.params.id);
    },
  );

  app.get(
    '/api/v1/grading/rectifications',
    {
      config: {
        permission: [
          'grading.rectification.request',
          'grading.rectification.endorse',
          'grading.rectification.approve',
        ],
      },
      schema: {
        tags: ['Grading'],
        summary: 'List rectifications (staff). Filter by status and/or target entry.',
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({ status: Type.Optional(Type.String()), entryId: Type.Optional(Uuid) }),
        response: { 200: Type.Array(Type.Any()), ...errorResponses },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, 'PROGRAM_CHAIR', 'REGISTRAR', 'ADMIN', 'INSTRUCTOR');
      return rectifications.list({ status: request.query.status, entryId: request.query.entryId });
    },
  );

  // ── INC lifecycle (BSL-304) ────────────────────────────────────────────────

  app.post(
    '/api/v1/grading/inc/:entryId/complete',
    {
      config: { permission: 'grading.inc.complete' },
      schema: {
        tags: ['Grading'],
        summary: 'Complete an outstanding INC with a numeric mark (Registrar/Admin + step-up MFA).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ entryId: Uuid }),
        body: Type.Object({ value: Type.String({ pattern: '^[1-5](\\.\\d{1,2})?$' }) }),
        response: {
          200: Type.Object({ entry: GradeEntrySchema, supersededId: Uuid }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const auth = requireStepUpMfa(request, ctx.config);
      if (!auth.roles.some((role) => ['REGISTRAR', 'ADMIN'].includes(role))) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'INC completion requires REGISTRAR or ADMIN.');
      }
      return inc.complete(auth.userId, request.params.entryId, request.body.value);
    },
  );

  app.post(
    '/api/v1/grading/inc/sweep',
    {
      config: { permission: 'grading.inc.complete' },
      schema: {
        tags: ['Grading'],
        summary: 'Manually run the expired-INC sweep (ADMIN). The hourly worker runs this automatically.',
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Object({
            scanned: Type.Integer(),
            converted: Type.Array(
              Type.Object({ entryId: Uuid, studentId: Uuid, courseId: Uuid, newEntryId: Uuid }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, 'ADMIN');
      return inc.sweepExpired();
    },
  );
}

export type { Mark };
