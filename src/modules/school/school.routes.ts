import { Type } from '@sinclair/typebox';
import type { AppServer } from '../../core/http/server-types';
import type { AppContext } from '../../context';
import { requireRoles } from '../../core/http/auth';
import { errorResponses, Uuid } from '../../core/http/schemas';
import type { SchoolService } from './school.service';

const GRADE_PATTERN = '^[0-5](\\.\\d{1,2})?$';

const SchoolProfileSchema = Type.Object({
  id: Uuid,
  code: Type.String(),
  name: Type.String(),
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('SUSPENDED')]),
  address: Type.Union([Type.String(), Type.Null()]),
  contactEmail: Type.Union([Type.String(), Type.Null()]),
  contactPhone: Type.Union([Type.String(), Type.Null()]),
  website: Type.Union([Type.String(), Type.Null()]),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  brandColor: Type.Union([Type.String(), Type.Null()]),
});

const SchoolPolicySchema = Type.Object({
  maxAcademicUnits: Type.Integer(),
  passingGradeMax: Type.String(),
  incDefaultGrade: Type.String(),
  incCompletionDays: Type.Integer(),
  deansListerMaxGwa: Type.String(),
  honorsSummaMax: Type.String(),
  honorsMagnaMax: Type.String(),
  honorsCumLaudeMax: Type.String(),
  currency: Type.String(),
});

const SchoolViewSchema = Type.Object({
  school: SchoolProfileSchema,
  policy: SchoolPolicySchema,
  policySource: Type.Union([Type.Literal('school'), Type.Literal('env')]),
});

const ProfilePatchSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  address: Type.Optional(Type.Union([Type.String({ maxLength: 300 }), Type.Null()])),
  contactEmail: Type.Optional(Type.Union([Type.String({ format: 'email', maxLength: 200 }), Type.Null()])),
  contactPhone: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
  website: Type.Optional(Type.Union([Type.String({ maxLength: 300 }), Type.Null()])),
  logoUrl: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
  brandColor: Type.Optional(Type.Union([Type.String({ pattern: '^#[0-9a-fA-F]{6}$' }), Type.Null()])),
});

const PolicyPatchSchema = Type.Object({
  maxAcademicUnits: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  passingGradeMax: Type.Optional(Type.String({ pattern: GRADE_PATTERN })),
  incDefaultGrade: Type.Optional(Type.String({ pattern: GRADE_PATTERN })),
  incCompletionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
  deansListerMaxGwa: Type.Optional(Type.String({ pattern: GRADE_PATTERN })),
  honorsSummaMax: Type.Optional(Type.String({ pattern: GRADE_PATTERN })),
  honorsMagnaMax: Type.Optional(Type.String({ pattern: GRADE_PATTERN })),
  honorsCumLaudeMax: Type.Optional(Type.String({ pattern: GRADE_PATTERN })),
  currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
});

export function registerSchoolRoutes(app: AppServer, ctx: AppContext, school: SchoolService): void {
  app.get(
    '/api/v1/school',
    {
      config: { permission: 'school.view.self' },
      schema: {
        tags: ['School'],
        summary: 'Current school profile, branding and effective academic policy.',
        security: [{ bearerAuth: [] }],
        response: { 200: SchoolViewSchema, ...errorResponses },
      },
    },
    async () => school.getProfile(),
  );

  app.patch(
    '/api/v1/school',
    {
      config: { permission: 'school.manage' },
      schema: {
        tags: ['School'],
        summary: 'Update school profile and branding (ADMIN).',
        security: [{ bearerAuth: [] }],
        body: ProfilePatchSchema,
        response: { 200: SchoolViewSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'ADMIN');
      return school.updateProfile(auth.userId, request.body);
    },
  );

  app.patch(
    '/api/v1/school/policies',
    {
      config: { permission: 'school.manage' },
      schema: {
        tags: ['School'],
        summary: 'Update academic policy (unit load limit, grade thresholds, INC window, currency) (ADMIN).',
        security: [{ bearerAuth: [] }],
        body: PolicyPatchSchema,
        response: { 200: SchoolViewSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = requireRoles(request, ctx.config, 'ADMIN');
      return school.updatePolicy(auth.userId, request.body);
    },
  );
}
