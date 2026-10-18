import { Type } from '@sinclair/typebox';
import type { AppServer } from '../../core/http/server-types';
import type { AppContext } from '../../context';
import { requireAuth, requireRoles, type Role } from '../../core/http/auth';
import { errorResponses, DateTime, NullableDateTime, ProblemDetailsSchema, Uuid } from '../../core/http/schemas';
import { AppError, ErrorCodes } from '../../core/errors/taxonomy';
import type { IamService } from './iam.service';
import type { HoldsService } from './holds.service';
import { PASSWORD_MIN_LENGTH } from './passwords';

const RoleSchema = Type.Union([
  Type.Literal('STUDENT'),
  Type.Literal('INSTRUCTOR'),
  Type.Literal('PROGRAM_CHAIR'),
  Type.Literal('REGISTRAR'),
  Type.Literal('CASHIER'),
  Type.Literal('ADMIN'),
]);

const HoldTypeSchema = Type.Union([Type.Literal('FINANCIAL'), Type.Literal('DISCIPLINARY'), Type.Literal('DOCUMENTARY')]);

const TokensSchema = Type.Object({
  tokenType: Type.Literal('Bearer'),
  accessToken: Type.String(),
  refreshToken: Type.String(),
  expiresInSeconds: Type.Integer({ description: 'Access token lifetime in seconds (15 minutes).' }),
});

const MeSchema = Type.Object({
  id: Uuid,
  email: Type.String({ format: 'email' }),
  firstName: Type.String(),
  lastName: Type.String(),
  roles: Type.Array(RoleSchema),
  status: Type.String(),
  totpEnabledAt: NullableDateTime,
  mfaEnabled: Type.Boolean(),
  createdAt: DateTime,
  updatedAt: DateTime,
  profile: Type.Union([
    Type.Null(),
    Type.Object({
      id: Uuid,
      studentNo: Type.String(),
      yearLevel: Type.Integer(),
      program: Type.Object({ id: Uuid, code: Type.String(), name: Type.String(), degreeTitle: Type.String() }),
      curriculumVersion: Type.Object({
        id: Uuid,
        version: Type.String(),
        name: Type.String(),
        unitsRequired: Type.Integer(),
        status: Type.String(),
      }),
    }),
  ]),
});

const UserSchema = Type.Object({
  id: Uuid,
  email: Type.String({ format: 'email' }),
  firstName: Type.String(),
  lastName: Type.String(),
  roles: Type.Array(RoleSchema),
  status: Type.String(),
  studentNo: Type.Union([Type.String(), Type.Null()]),
  createdAt: DateTime,
  updatedAt: DateTime,
});

const HoldSchema = Type.Object({
  id: Uuid,
  studentId: Uuid,
  type: HoldTypeSchema,
  reason: Type.String(),
  startsAt: DateTime,
  endsAt: NullableDateTime,
  liftedAt: NullableDateTime,
  createdBy: Type.Union([Uuid, Type.Null()]),
  createdAt: DateTime,
});

export interface IamServices {
  iam: IamService;
  holds: HoldsService;
}

export function registerIamRoutes(app: AppServer, ctx: AppContext, services: IamServices): void {
  const { iam, holds } = services;

  app.post(
    '/api/v1/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Password login. Returns tokens, or an MFA challenge when TOTP is enabled.',
        body: Type.Object({
          email: Type.String({ format: 'email' }),
          password: Type.String({ minLength: 1 }),
        }),
        response: {
          200: Type.Union([
            TokensSchema,
            Type.Object({ mfaRequired: Type.Literal(true), mfaToken: Type.String() }),
          ]),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      return iam.login(request.body.email, request.body.password);
    },
  );

  app.post(
    '/api/v1/auth/mfa/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Complete an MFA login challenge with a TOTP code.',
        body: Type.Object({
          mfaToken: Type.String(),
          code: Type.String({ minLength: 6, maxLength: 6 }),
        }),
        response: { 200: TokensSchema, ...errorResponses },
      },
    },
    async (request) => iam.completeMfaLogin(request.body.mfaToken, request.body.code),
  );

  app.post(
    '/api/v1/auth/refresh',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token. Reuse of a rotated token revokes the whole family.',
        body: Type.Object({ refreshToken: Type.String({ minLength: 16 }) }),
        response: { 200: TokensSchema, ...errorResponses },
      },
    },
    async (request) => iam.refresh(request.body.refreshToken),
  );

  app.post(
    '/api/v1/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Revoke the session family of the presented refresh token.',
        body: Type.Object({ refreshToken: Type.String({ minLength: 16 }) }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await iam.logout(request.body.refreshToken);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/api/v1/auth/logout-all',
    {
      config: { permission: 'iam.self.manage' },
      schema: {
        tags: ['Auth'],
        summary: 'Revoke every session family for the current user.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Object({ revokedFamilies: Type.Integer() }), ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return { revokedFamilies: await iam.logoutAll(auth.userId) };
    },
  );

  app.post(
    '/api/v1/auth/step-up',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' }, permission: 'iam.self.manage' },
      schema: {
        tags: ['Auth'],
        summary: 'Step-up MFA: exchange a TOTP code for an access token elevated for 5 minutes.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({ code: Type.String({ minLength: 6, maxLength: 6 }) }),
        response: { 200: TokensSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return iam.stepUp(auth.userId, request.body.code, auth.sessionId);
    },
  );

  app.post(
    '/api/v1/auth/totp/setup',
    {
      config: { permission: 'iam.self.manage' },
      schema: {
        tags: ['Auth'],
        summary: 'Begin TOTP enrollment. Returns the shared secret and otpauth URL.',
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Object({ secret: Type.String(), otpauthUrl: Type.String() }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return iam.beginTotpSetup(auth.userId);
    },
  );

  app.post(
    '/api/v1/auth/totp/enable',
    {
      config: { permission: 'iam.self.manage' },
      schema: {
        tags: ['Auth'],
        summary: 'Confirm TOTP enrollment with the first generated code.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({ code: Type.String({ minLength: 6, maxLength: 6 }) }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request, ctx.config);
      await iam.enableTotp(auth.userId, request.body.code);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/api/v1/auth/me',
    {
      config: { permission: 'iam.self.manage' },
      schema: {
        tags: ['Auth'],
        summary: 'Current user profile with roles, student profile and MFA state.',
        security: [{ bearerAuth: [] }],
        response: { 200: MeSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return iam.me(auth.userId);
    },
  );

  // ── User administration ────────────────────────────────────────────────────

  app.post(
    '/api/v1/iam/users',
    {
      config: { permission: 'iam.users.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Create a user (optionally with a student profile). ADMIN only.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          email: Type.String({ format: 'email' }),
          password: Type.String({ minLength: PASSWORD_MIN_LENGTH }),
          firstName: Type.String({ minLength: 1 }),
          lastName: Type.String({ minLength: 1 }),
          roles: Type.Array(RoleSchema, { minItems: 1 }),
          student: Type.Optional(
            Type.Object({
              studentNo: Type.String({ minLength: 1 }),
              programId: Uuid,
              curriculumVersionId: Uuid,
              yearLevel: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
            }),
          ),
        }),
        response: { 201: UserSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = requireRoles(request, ctx.config, 'ADMIN');
      const user = await iam.createUser(auth.userId, {
        ...request.body,
        roles: request.body.roles as Role[],
      });
      return reply.status(201).send(user);
    },
  );

  app.get(
    '/api/v1/iam/users',
    {
      config: { permission: 'iam.users.list' },
      schema: {
        tags: ['IAM'],
        summary: 'List users. ADMIN and REGISTRAR only.',
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({
          role: Type.Optional(RoleSchema),
          search: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
        response: { 200: Type.Array(UserSchema), ...errorResponses },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, 'ADMIN', 'REGISTRAR');
      return iam.listUsers({
        limit: request.query.limit ?? 50,
        role: request.query.role as Role | undefined,
        search: request.query.search,
      });
    },
  );

  // ── Holds ──────────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/iam/students/:studentId/holds',
    {
      config: { permission: 'iam.holds.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Place a hold on a student. FINANCIAL: CASHIER/REGISTRAR/ADMIN; DISCIPLINARY & DOCUMENTARY: REGISTRAR/ADMIN.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ studentId: Uuid }),
        body: Type.Object({
          type: HoldTypeSchema,
          reason: Type.String({ minLength: 3, maxLength: 500 }),
          endsAt: Type.Optional(DateTime),
        }),
        response: { 201: HoldSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const type = request.body.type;
      if (type === 'FINANCIAL') {
        requireRoles(request, ctx.config, 'CASHIER', 'REGISTRAR', 'ADMIN');
      } else {
        requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN');
      }
      const auth = requireAuth(request, ctx.config);
      const hold = await holds.createHold(auth.userId, {
        studentId: request.params.studentId,
        type,
        reason: request.body.reason,
        endsAt: request.body.endsAt ? new Date(request.body.endsAt as string) : undefined,
      });
      return reply.status(201).send(hold);
    },
  );

  app.post(
    '/api/v1/iam/holds/:holdId/lift',
    {
      config: { permission: 'iam.holds.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Lift a hold. REGISTRAR/ADMIN (FINANCIAL also CASHIER).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ holdId: Uuid }),
        response: { 200: HoldSchema, ...errorResponses },
      },
    },
    async (request) => {
      requireRoles(request, ctx.config, 'CASHIER', 'REGISTRAR', 'ADMIN');
      const auth = requireAuth(request, ctx.config);
      const hold = await holds.liftHold(auth.userId, request.params.holdId);
      if (hold.type === 'DISCIPLINARY' || hold.type === 'DOCUMENTARY') {
        requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN');
      }
      return hold;
    },
  );

  app.get(
    '/api/v1/iam/students/:studentId/holds',
    {
      config: { permission: 'iam.holds.view' },
      schema: {
        tags: ['IAM'],
        summary: 'List holds of a student.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ studentId: Uuid }),
        querystring: Type.Object({ includeLifted: Type.Optional(Type.Boolean({ default: false })) }),
        response: { 200: Type.Array(HoldSchema), ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'REGISTRAR', 'ADMIN', 'CASHIER', 'STUDENT');
      if (auth.roles.includes('STUDENT') && !auth.roles.some((r) => ['REGISTRAR', 'ADMIN', 'CASHIER'].includes(r)) && auth.userId !== request.params.studentId) {
        throw new AppError(ErrorCodes.FORBIDDEN, 'Students may only inspect their own holds.');
      }
      return holds.listHolds(request.params.studentId, request.query.includeLifted ?? false);
    },
  );
}
