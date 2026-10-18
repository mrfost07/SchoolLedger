import { Type } from '@sinclair/typebox';
import type { AppServer } from '../../core/http/server-types';
import type { AppContext } from '../../context';
import { requireAuth, type Role } from '../../core/http/auth';
import { errorResponses, DateTime, NullableDateTime, Uuid } from '../../core/http/schemas';
import type { RoleCode } from './permissions';
import { PERMISSIONS } from './permissions';
import { PASSWORD_MIN_LENGTH } from './passwords';
import { RoleSchema, TokensSchema } from './iam.routes';
import type { IamAdminService } from './iam-admin.service';

const InvitationStatusSchema = Type.Union([Type.Literal('PENDING'), Type.Literal('ACCEPTED'), Type.Literal('REVOKED')]);

const InvitationSchema = Type.Object({
  id: Uuid,
  email: Type.String({ format: 'email' }),
  firstName: Type.String(),
  lastName: Type.String(),
  roles: Type.Array(RoleSchema),
  status: Type.String(),
  expiresAt: DateTime,
  acceptedAt: NullableDateTime,
  createdAt: DateTime,
});

const RoleTemplateSchema = Type.Object({
  roleCode: RoleSchema,
  source: Type.Union([Type.Literal('school'), Type.Literal('default'), Type.Literal('builtin')]),
  permissions: Type.Array(Type.String()),
});

const PermissionSchema = Type.Object({
  code: Type.String(),
  module: Type.String(),
  description: Type.String(),
});

const MembershipStatusResponseSchema = Type.Object({
  userId: Uuid,
  membershipId: Uuid,
  status: Type.String(),
});

const RoleAssignmentResponseSchema = Type.Object({
  userId: Uuid,
  roles: Type.Array(RoleSchema),
});

export interface IamAdminServices {
  admin: IamAdminService;
}

/**
 * Phase 2 IAM administration routes. All authenticated endpoints enforce
 * registry permissions only — delegating them to non-ADMIN roles is a
 * per-school policy choice through role-template overrides.
 */
export function registerIamAdminRoutes(app: AppServer, ctx: AppContext, services: IamAdminServices): void {
  const { admin } = services;

  // ── Registry & templates ───────────────────────────────────────────────────

  app.get(
    '/api/v1/iam/permissions',
    {
      config: { permission: 'iam.templates.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'List the permission registry.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Array(PermissionSchema), ...errorResponses },
      },
    },
    async () => PERMISSIONS.map((permission) => ({ ...permission })),
  );

  app.get(
    '/api/v1/iam/role-templates',
    {
      config: { permission: 'iam.templates.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Effective role templates for this school (school override, seeded default or built-in).',
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Object({
            mode: Type.String(),
            templates: Type.Array(RoleTemplateSchema),
          }),
          ...errorResponses,
        },
      },
    },
    async () => admin.listRoleTemplates(),
  );

  app.put(
    '/api/v1/iam/role-templates/:roleCode',
    {
      config: { permission: 'iam.templates.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Create or replace this school\'s override for a role template. ADMIN template is fixed.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ roleCode: RoleSchema }),
        body: Type.Object({ permissions: Type.Array(Type.String()) }),
        response: { 200: RoleTemplateSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return admin.setRoleTemplate(auth.userId, request.params.roleCode as RoleCode, request.body.permissions);
    },
  );

  app.delete(
    '/api/v1/iam/role-templates/:roleCode',
    {
      config: { permission: 'iam.templates.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Remove this school\'s override for a role template (revert to the seeded default).',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ roleCode: RoleSchema }),
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request, ctx.config);
      await admin.revertRoleTemplate(auth.userId, request.params.roleCode as RoleCode);
      return reply.status(204).send(null);
    },
  );

  // ── Invitations ────────────────────────────────────────────────────────────

  app.get(
    '/api/v1/iam/invitations',
    {
      config: { permission: 'iam.invitations.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'List invitations of this school.',
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({
          status: Type.Optional(InvitationStatusSchema),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }),
        response: { 200: Type.Array(InvitationSchema), ...errorResponses },
      },
    },
    async (request) => admin.listInvitations({ status: request.query.status, limit: request.query.limit ?? 50 }),
  );

  app.post(
    '/api/v1/iam/invitations',
    {
      config: { permission: 'iam.invitations.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Invite a user by email. The raw token is returned exactly once.',
        security: [{ bearerAuth: [] }],
        body: Type.Object({
          email: Type.String({ format: 'email' }),
          firstName: Type.String({ minLength: 1 }),
          lastName: Type.String({ minLength: 1 }),
          roles: Type.Array(RoleSchema, { minItems: 1 }),
        }),
        response: {
          201: Type.Object({ ...InvitationSchema.properties, token: Type.String() }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request, ctx.config);
      const invitation = await admin.createInvitation(auth.userId, {
        email: request.body.email,
        firstName: request.body.firstName,
        lastName: request.body.lastName,
        roles: request.body.roles as Role[],
      });
      return reply.status(201).send(invitation);
    },
  );

  app.post(
    '/api/v1/iam/invitations/:invitationId/revoke',
    {
      config: { permission: 'iam.invitations.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Revoke a pending invitation.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ invitationId: Uuid }),
        response: { 200: InvitationSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return admin.revokeInvitation(auth.userId, request.params.invitationId);
    },
  );

  app.post(
    '/api/v1/auth/invitations/accept',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        summary: 'Accept an invitation: sets the password, provisions the account and returns a first session.',
        body: Type.Object({
          token: Type.String({ minLength: 16 }),
          password: Type.String({ minLength: PASSWORD_MIN_LENGTH }),
        }),
        response: {
          200: Type.Object({
            user: Type.Object({
              id: Uuid,
              email: Type.String({ format: 'email' }),
              firstName: Type.String(),
              lastName: Type.String(),
              roles: Type.Array(RoleSchema),
              status: Type.String(),
            }),
            tokens: TokensSchema,
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => admin.acceptInvitation({ token: request.body.token, password: request.body.password }),
  );

  // ── Membership lifecycle & role assignments ────────────────────────────────

  app.post(
    '/api/v1/iam/users/:userId/suspend',
    {
      config: { permission: 'iam.memberships.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Suspend a user\'s membership in this school. Refresh grants stop immediately.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ userId: Uuid }),
        body: Type.Object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }),
        response: { 200: MembershipStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return admin.setMembershipStatus(auth.userId, request.params.userId, 'SUSPENDED', request.body.reason);
    },
  );

  app.post(
    '/api/v1/iam/users/:userId/activate',
    {
      config: { permission: 'iam.memberships.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Reactivate a suspended membership in this school.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ userId: Uuid }),
        response: { 200: MembershipStatusResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return admin.setMembershipStatus(auth.userId, request.params.userId, 'ACTIVE');
    },
  );

  app.put(
    '/api/v1/iam/users/:userId/roles',
    {
      config: { permission: 'iam.memberships.manage' },
      schema: {
        tags: ['IAM'],
        summary: 'Replace a user\'s role assignments in this school.',
        security: [{ bearerAuth: [] }],
        params: Type.Object({ userId: Uuid }),
        body: Type.Object({ roles: Type.Array(RoleSchema, { minItems: 1 }) }),
        response: { 200: RoleAssignmentResponseSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireAuth(request, ctx.config);
      return admin.updateRoles(auth.userId, request.params.userId, request.body.roles as Role[]);
    },
  );
}
