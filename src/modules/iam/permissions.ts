import type { SchoolMode } from '@prisma/client';

/**
 * Permission registry (ADR-0004): permissions are data; routes declare them
 * via `config.permission`; role templates grant them per school mode.
 *
 * The `onRoute` policy-coverage test enforces that every authenticated route
 * declares a permission code that exists in this registry.
 */

export interface PermissionSpec {
  code: string;
  module: string;
  description: string;
}

export type RoleCode = 'STUDENT' | 'INSTRUCTOR' | 'PROGRAM_CHAIR' | 'REGISTRAR' | 'CASHIER' | 'ADMIN';

export const PERMISSIONS: readonly PermissionSpec[] = [
  // academics
  { code: 'academics.department.manage', module: 'academics', description: 'Create departments' },
  { code: 'academics.program.manage', module: 'academics', description: 'Create programs' },
  { code: 'academics.curriculum.manage', module: 'academics', description: 'Create curricula and add courses' },
  { code: 'academics.curriculum.status', module: 'academics', description: 'Transition curriculum status' },
  { code: 'academics.course.manage', module: 'academics', description: 'Create courses' },
  { code: 'academics.requisite.manage', module: 'academics', description: 'Upsert/remove course requisites' },
  { code: 'academics.term.manage', module: 'academics', description: 'Create terms and transition status' },
  { code: 'academics.room.manage', module: 'academics', description: 'Create rooms' },
  { code: 'academics.section.manage', module: 'academics', description: 'Create sections and schedules' },
  { code: 'academics.section.status', module: 'academics', description: 'Open/cancel sections' },
  { code: 'academics.views.staff', module: 'academics', description: 'Read academic structure (staff views)' },
  { code: 'academics.views.self', module: 'academics', description: 'Read academic structure relevant to self' },

  // enrollment
  { code: 'enrollment.reserve', module: 'enrollment', description: 'Reserve sections for self' },
  { code: 'enrollment.drop', module: 'enrollment', description: 'Drop own enrollment items' },
  { code: 'enrollment.waitlist.join', module: 'enrollment', description: 'Join a waitlist for self' },
  { code: 'enrollment.view.self', module: 'enrollment', description: 'Read own enrollments/assessments' },
  { code: 'enrollment.view.any', module: 'enrollment', description: 'Read any student enrollments' },
  { code: 'enrollment.manage', module: 'enrollment', description: 'Administrative enrollment operations (waitlist promotion)' },
  { code: 'fees.view.self', module: 'enrollment', description: 'Read own assessment' },
  { code: 'fees.view.any', module: 'enrollment', description: 'Read any assessment' },
  { code: 'fees.collect', module: 'enrollment', description: 'Collect payments / mark assessments paid' },

  // grading
  { code: 'grading.entries.save', module: 'grading', description: 'Save draft grade entries for assigned sections' },
  { code: 'grading.sheet.submit', module: 'grading', description: 'Submit grade sheet from DRAFT' },
  { code: 'grading.sheet.verify', module: 'grading', description: 'Verify submitted grade sheet (chair)' },
  { code: 'grading.sheet.post', module: 'grading', description: 'Post verified grade sheet (registrar)' },
  { code: 'grading.view.assigned', module: 'grading', description: 'Read sheets/rosters of assigned sections' },
  { code: 'grading.view.any', module: 'grading', description: 'Read any sheet/roster' },
  { code: 'grading.gwa.view.self', module: 'grading', description: 'Read own GWA/standing' },
  { code: 'grading.gwa.view.any', module: 'grading', description: 'Read any student GWA/standing' },
  { code: 'grading.rectification.request', module: 'grading', description: 'Request a grade rectification' },
  { code: 'grading.rectification.endorse', module: 'grading', description: 'Endorse a rectification (chair)' },
  { code: 'grading.rectification.approve', module: 'grading', description: 'Approve a rectification (registrar)' },
  { code: 'grading.inc.complete', module: 'grading', description: 'Complete an outstanding INC' },

  // documents
  { code: 'documents.request.self', module: 'documents', description: 'Request own documents' },
  { code: 'documents.request.any', module: 'documents', description: 'Request documents for any student' },
  { code: 'documents.view.self', module: 'documents', description: 'List/read own document requests' },
  { code: 'documents.view.any', module: 'documents', description: 'List/read any document request' },
  { code: 'documents.download.self', module: 'documents', description: 'Download own documents' },
  { code: 'documents.download.any', module: 'documents', description: 'Download any document' },
  { code: 'documents.manage.any', module: 'documents', description: 'Revoke/retry document requests for any student' },

  // iam
  { code: 'iam.self.manage', module: 'iam', description: 'Manage own session: logout, step-up MFA, TOTP enrollment' },
  { code: 'iam.users.manage', module: 'iam', description: 'Create/manage users' },
  { code: 'iam.users.list', module: 'iam', description: 'List users' },
  { code: 'iam.holds.manage', module: 'iam', description: 'Create/lift student holds' },
  { code: 'iam.holds.view', module: 'iam', description: 'Read student holds' },
  { code: 'iam.students.view', module: 'iam', description: 'Read student profiles' },

  // audit
  { code: 'audit.read', module: 'audit', description: 'Read audit logs' },
  { code: 'audit.verify', module: 'audit', description: 'Verify audit chain integrity' },
] as const;

export interface RoleTemplateSpec {
  mode: SchoolMode;
  roleCode: RoleCode;
  permissions: readonly string[];
}

const STUDENT_PERMISSIONS = [
  'academics.views.self',
  'enrollment.reserve',
  'enrollment.drop',
  'enrollment.waitlist.join',
  'enrollment.view.self',
  'fees.view.self',
  'grading.gwa.view.self',
  'documents.request.self',
  'documents.view.self',
  'documents.download.self',
  'iam.self.manage',
  'iam.holds.view',
] as const;

const INSTRUCTOR_PERMISSIONS = [
  'academics.views.self',
  'grading.entries.save',
  'grading.sheet.submit',
  'grading.view.assigned',
  'grading.inc.complete',
  'grading.rectification.request',
  'enrollment.view.any',
  'iam.self.manage',
] as const;

const PROGRAM_CHAIR_PERMISSIONS = [
  'academics.views.staff',
  'academics.views.self',
  'grading.view.assigned',
  'grading.sheet.verify',
  'grading.rectification.endorse',
  'enrollment.view.any',
  'iam.self.manage',
] as const;

const REGISTRAR_PERMISSIONS = [
  'academics.views.staff',
  'academics.views.self',
  'academics.department.manage',
  'academics.program.manage',
  'academics.curriculum.manage',
  'academics.curriculum.status',
  'academics.course.manage',
  'academics.requisite.manage',
  'academics.term.manage',
  'academics.room.manage',
  'academics.section.manage',
  'academics.section.status',
  'enrollment.view.any',
  'enrollment.manage',
  'fees.view.any',
  'grading.view.any',
  'grading.gwa.view.any',
  'grading.sheet.post',
  'grading.rectification.approve',
  'grading.inc.complete',
  'documents.request.any',
  'documents.view.any',
  'documents.download.any',
  'documents.manage.any',
  'iam.self.manage',
  'iam.users.list',
  'iam.holds.view',
  'iam.students.view',
] as const;

const CASHIER_PERMISSIONS = [
  'academics.views.self',
  'enrollment.view.any',
  'fees.view.any',
  'fees.collect',
  'iam.self.manage',
  'iam.holds.manage',
  'iam.holds.view',
  'iam.students.view',
] as const;

const ADMIN_PERMISSIONS = PERMISSIONS.map((permission) => permission.code);

export const ROLE_TEMPLATES: readonly RoleTemplateSpec[] = [
  { mode: 'HE', roleCode: 'STUDENT', permissions: STUDENT_PERMISSIONS },
  { mode: 'HE', roleCode: 'INSTRUCTOR', permissions: INSTRUCTOR_PERMISSIONS },
  { mode: 'HE', roleCode: 'PROGRAM_CHAIR', permissions: PROGRAM_CHAIR_PERMISSIONS },
  { mode: 'HE', roleCode: 'REGISTRAR', permissions: REGISTRAR_PERMISSIONS },
  { mode: 'HE', roleCode: 'CASHIER', permissions: CASHIER_PERMISSIONS },
  { mode: 'HE', roleCode: 'ADMIN', permissions: ADMIN_PERMISSIONS },
] as const;
