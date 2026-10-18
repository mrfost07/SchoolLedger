import { Type } from '@sinclair/typebox';
import type { AppServer } from '../../core/http/server-types';
import type { AppContext } from '../../context';
import { requireAuth, requireRoles } from '../../core/http/auth';
import { errorResponses, Uuid } from '../../core/http/schemas';
import type { AcademicsService } from './academics.service';
import {
  AcademicTermSchema,
  CourseSchema,
  CurriculumVersionSchema,
  DepartmentSchema,
  ProgramSchema,
  RequisiteTypeSchema,
  RoomSchema,
  ScheduleInputSchema,
  SectionSchema,
  SectionScheduleSchema,
} from './academics.schemas';

const RegistrarOrAdmin = ['REGISTRAR', 'ADMIN'] as const;

export function registerAcademicsRoutes(app: AppServer, ctx: AppContext, service: AcademicsService): void {
  const actorId = (request: Parameters<typeof requireAuth>[0]) => requireAuth(request, ctx.config).userId;

  // ── Structure ──────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/academics/departments',
    {
      config: { permission: 'academics.department.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create a department. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({ code: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) }),
        response: { 201: DepartmentSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const department = await service.createDepartment(actorId(request), request.body);
      return reply.status(201).send(department);
    },
  );

  app.post(
    '/api/v1/academics/programs',
    {
      config: { permission: 'academics.program.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create a program. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          code: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          degreeTitle: Type.String({ minLength: 1 }),
          departmentId: Uuid,
        }),
        response: { 201: ProgramSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const program = await service.createProgram(actorId(request), request.body);
      return reply.status(201).send(program);
    },
  );

  app.post(
    '/api/v1/academics/programs/:programId/curricula',
    {
      config: { permission: 'academics.curriculum.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create a curriculum version (prospectus). REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ programId: Uuid }),
        body: Type.Object({
          version: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          unitsRequired: Type.Integer({ minimum: 1 }),
          effectiveFrom: Type.Optional(Type.String({ format: 'date-time' })),
        }),
        response: { 201: CurriculumVersionSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const curriculum = await service.createCurriculumVersion(actorId(request), {
        programId: request.params.programId,
        ...request.body,
        effectiveFrom: request.body.effectiveFrom ? new Date(request.body.effectiveFrom) : undefined,
      });
      return reply.status(201).send(curriculum);
    },
  );

  app.post(
    '/api/v1/academics/curricula/:curriculumVersionId/status',
    {
      config: { permission: 'academics.curriculum.status' },
      schema: {
        tags: ['Academics'],
        summary: 'Transition curriculum status DRAFT → ACTIVE → ARCHIVED. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ curriculumVersionId: Uuid }),
        body: Type.Object({ status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]) }),
        response: { 200: CurriculumVersionSchema, ...errorResponses },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      return service.setCurriculumStatus(actorId(request), request.params.curriculumVersionId, request.body.status);
    },
  );

  app.post(
    '/api/v1/academics/courses',
    {
      config: { permission: 'academics.course.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create a course. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          code: Type.String({ minLength: 1 }),
          title: Type.String({ minLength: 1 }),
          lectureUnits: Type.Integer({ minimum: 0, maximum: 12 }),
          labUnits: Type.Optional(Type.Integer({ minimum: 0, maximum: 12, default: 0 })),
          description: Type.Optional(Type.String()),
        }),
        response: { 201: CourseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const course = await service.createCourse(actorId(request), request.body);
      return reply.status(201).send(course);
    },
  );

  app.post(
    '/api/v1/academics/curricula/:curriculumVersionId/courses',
    {
      config: { permission: 'academics.curriculum.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Place a course in the curriculum grid. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ curriculumVersionId: Uuid }),
        body: Type.Object({
          courseId: Uuid,
          yearLevel: Type.Integer({ minimum: 1, maximum: 10 }),
          termNo: Type.Integer({ minimum: 1, maximum: 6 }),
          isRequired: Type.Optional(Type.Boolean({ default: true })),
        }),
        response: {
          201: Type.Object({
            id: Uuid,
            curriculumVersionId: Uuid,
            courseId: Uuid,
            yearLevel: Type.Integer(),
            termNo: Type.Integer(),
            isRequired: Type.Boolean(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const entry = await service.addCourseToCurriculum(actorId(request), request.params.curriculumVersionId, request.body);
      return reply.status(201).send(entry);
    },
  );

  // ── Requisites (DAG validated) ─────────────────────────────────────────────

  app.post(
    '/api/v1/academics/requisites',
    {
      config: { permission: 'academics.requisite.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create/update a course requisite. Rejected when it would introduce a cycle (DAG_CYCLE_DETECTED).',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          courseId: Uuid,
          requiredCourseId: Uuid,
          type: RequisiteTypeSchema,
          minGrade: Type.Optional(Type.String({ pattern: '^[1-5](\\.\\d{1,2})?$' })),
        }),
        response: {
          201: Type.Object({ id: Uuid, courseId: Uuid, requiredCourseId: Uuid, type: RequisiteTypeSchema }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const requisite = await service.upsertRequisite(actorId(request), request.body);
      return reply.status(201).send(requisite);
    },
  );

  app.delete(
    '/api/v1/academics/requisites/:requisiteId',
    {
      config: { permission: 'academics.requisite.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Remove a requisite. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ requisiteId: Uuid }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      await service.removeRequisite(actorId(request), request.params.requisiteId);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/api/v1/academics/curricula/:curriculumVersionId/graph',
    {
      config: { permission: ['academics.views.staff', 'academics.views.self'] },
      schema: {
        tags: ['Academics'],
        summary: 'Curriculum DAG view: courses, requisites, topological order, unlock counts.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ curriculumVersionId: Uuid }),
        response: {
          200: Type.Object({
            curriculumVersionId: Uuid,
            courses: Type.Array(
              Type.Object({
                courseId: Uuid,
                code: Type.String(),
                title: Type.String(),
                yearLevel: Type.Integer(),
                termNo: Type.Integer(),
                unlocksCount: Type.Integer(),
              }),
            ),
            requisites: Type.Array(
              Type.Object({ courseId: Uuid, requiredCourseId: Uuid, type: RequisiteTypeSchema }),
            ),
            topologicalOrder: Type.Array(Uuid),
            isAcyclic: Type.Boolean(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN', 'PROGRAM_CHAIR', 'INSTRUCTOR');
      return service.getCurriculumGraph(request.params.curriculumVersionId);
    },
  );

  // ── Terms ──────────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/academics/terms',
    {
      config: { permission: 'academics.term.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create an academic term with enrollment and grading windows. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          code: Type.String({ minLength: 1 }),
          schoolYear: Type.Integer({ minimum: 2000 }),
          termNo: Type.Integer({ minimum: 1, maximum: 6 }),
          startsAt: Type.String({ format: 'date-time' }),
          endsAt: Type.String({ format: 'date-time' }),
          enrollmentStartAt: Type.String({ format: 'date-time' }),
          addDropEndAt: Type.String({ format: 'date-time' }),
          gradingStartAt: Type.String({ format: 'date-time' }),
          gradingEndAt: Type.String({ format: 'date-time' }),
        }),
        response: { 201: AcademicTermSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const term = await service.createTerm(actorId(request), {
        ...request.body,
        startsAt: new Date(request.body.startsAt),
        endsAt: new Date(request.body.endsAt),
        enrollmentStartAt: new Date(request.body.enrollmentStartAt),
        addDropEndAt: new Date(request.body.addDropEndAt),
        gradingStartAt: new Date(request.body.gradingStartAt),
        gradingEndAt: new Date(request.body.gradingEndAt),
      });
      return reply.status(201).send(term);
    },
  );

  app.post(
    '/api/v1/academics/terms/:termId/status',
    {
      config: { permission: 'academics.term.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Advance the term state machine (PLANNING → ENROLLMENT → ADD_DROP → ONGOING → GRADING → CLOSED).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ termId: Uuid }),
        body: Type.Object({
          status: Type.Union([
            Type.Literal('ENROLLMENT'),
            Type.Literal('ADD_DROP'),
            Type.Literal('ONGOING'),
            Type.Literal('GRADING'),
            Type.Literal('CLOSED'),
          ]),
        }),
        response: { 200: AcademicTermSchema, ...errorResponses },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      return service.setTermStatus(actorId(request), request.params.termId, request.body.status);
    },
  );

  app.get(
    '/api/v1/academics/terms',
    {
      config: { permission: ['academics.views.self', 'academics.views.staff'] },
      schema: {
        tags: ['Academics'],
        summary: 'List terms.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Array(AcademicTermSchema), ...errorResponses },
      },
    },
    async (request) => {
      requireAuth(request, ctx.config);
      return service.listTerms();
    },
  );

  // ── Rooms ──────────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/academics/rooms',
    {
      config: { permission: 'academics.room.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create a room. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          code: Type.String({ minLength: 1 }),
          building: Type.String({ minLength: 1 }),
          capacity: Type.Integer({ minimum: 1 }),
        }),
        response: { 201: RoomSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const room = await service.createRoom(actorId(request), request.body);
      return reply.status(201).send(room);
    },
  );

  app.get(
    '/api/v1/academics/rooms',
    {
      config: { permission: ['academics.views.self', 'academics.views.staff'] },
      schema: {
        tags: ['Academics'],
        summary: 'List rooms.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Array(RoomSchema), ...errorResponses },
      },
    },
    async (request) => {
      requireAuth(request, ctx.config);
      return service.listRooms();
    },
  );

  // ── Sections & schedules ───────────────────────────────────────────────────

  app.post(
    '/api/v1/academics/sections',
    {
      config: { permission: 'academics.section.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Create a section with conflict-checked schedules. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          termId: Uuid,
          courseId: Uuid,
          sectionCode: Type.String({ minLength: 1, maxLength: 10 }),
          instructorId: Type.Optional(Uuid),
          maxCapacity: Type.Integer({ minimum: 1 }),
          schedules: Type.Optional(Type.Array(ScheduleInputSchema)),
        }),
        response: { 201: SectionSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const section = await service.createSection(actorId(request), request.body);
      return reply.status(201).send(section);
    },
  );

  app.post(
    '/api/v1/academics/sections/:sectionId/schedules',
    {
      config: { permission: 'academics.section.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Add a schedule slot to a section (conflict-checked, GiST-enforced). REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        body: ScheduleInputSchema,
        response: { 201: SectionScheduleSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      const schedule = await service.addSchedule(actorId(request), request.params.sectionId, request.body);
      return reply.status(201).send(schedule);
    },
  );

  app.delete(
    '/api/v1/academics/schedules/:scheduleId',
    {
      config: { permission: 'academics.section.manage' },
      schema: {
        tags: ['Academics'],
        summary: 'Remove a schedule slot. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ scheduleId: Uuid }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      await service.removeSchedule(actorId(request), request.params.scheduleId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/api/v1/academics/sections/:sectionId/status',
    {
      config: { permission: 'academics.section.status' },
      schema: {
        tags: ['Academics'],
        summary: 'Open/close/cancel a section. REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        body: Type.Object({ status: Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED'), Type.Literal('CANCELLED')]) }),
        response: { 200: SectionSchema, ...errorResponses },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, ...RegistrarOrAdmin);
      return service.setSectionStatus(actorId(request), request.params.sectionId, request.body.status);
    },
  );

  app.get(
    '/api/v1/academics/terms/:termId/sections',
    {
      config: { permission: ['academics.views.self', 'academics.views.staff'] },
      schema: {
        tags: ['Academics'],
        summary: 'List sections of a term (optionally filtered by course) with schedules and live counts.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ termId: Uuid }),
        querystring: Type.Object({ courseId: Type.Optional(Uuid) }),
        response: { 200: Type.Array(Type.Any()), ...errorResponses },
      },
    },
    async (request) => {
      requireAuth(request, ctx.config);
      return service.listSections(request.params.termId, request.query.courseId);
    },
  );

  app.get(
    '/api/v1/academics/sections/:sectionId',
    {
      config: { permission: ['academics.views.self', 'academics.views.staff'] },
      schema: {
        tags: ['Academics'],
        summary: 'Section detail with course, term, instructor and schedules.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ sectionId: Uuid }),
        response: { 200: Type.Any(), ...errorResponses },
      },
    },
    async (request) => {
      requireAuth(request, ctx.config);
      return service.getSectionOrThrow(request.params.sectionId);
    },
  );
}
