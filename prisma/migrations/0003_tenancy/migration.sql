-- =============================================================================
-- 0003_tenancy - Phase 1a multi-tenant foundations (ADR-0001/0002/0004)
--
--   * Tenant registry: schools, school_policies, memberships, role_assignments
--   * Permission registry: permissions, role_templates, role_template_permissions
--   * schoolId on every tenant table (NOT NULL except audit_logs, which keeps
--     NULL for platform/system events) + FK to schools
--   * Per-school unique indexes (codes, student numbers, serials, idempotency)
--   * Double-booking EXCLUDE constraints rebuilt with schoolId
--   * RLS ENABLE + FORCE + "tenant isolation" policies scoped by
--     app.current_school_id (nil by default => fail closed) or app.system='on'
--   * Application role "schoolledger_app" (NOBYPASSRLS) + grants
--
-- Runtime note (documented debt): the app keeps connecting as the database
-- owner during 1a, so RLS stays dormant for it; tenant scoping at runtime is
-- enforced by the Prisma tenant extension (fail-closed ALS context). The
-- schoolledger_app role is the enforcement point today for the IDOR probe
-- suite and any future direct/reporting connections. Propagating the GUC per
-- transaction for the runtime role is scheduled with the Phase 12 hardening.
--
-- Existing rows are backfilled to School #1 (fixed UUID below) because every
-- pre-1a row belonged to the single-tenant deployment.
-- =============================================================================

-- -- Enums ---------------------------------------------------------------------
CREATE TYPE "SchoolStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "SchoolMode" AS ENUM ('HE', 'K12');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- -- Tenant registry -----------------------------------------------------------
CREATE TABLE "schools" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "SchoolStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "school_policies" (
    "schoolId" UUID NOT NULL,
    "mode" "SchoolMode" NOT NULL DEFAULT 'HE',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Manila',
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "maxAcademicUnits" INTEGER NOT NULL DEFAULT 30,
    "passingGradeMax" DECIMAL(3,2) NOT NULL DEFAULT 3.0,
    "incDefaultGrade" DECIMAL(3,2) NOT NULL DEFAULT 5.0,
    "deansListerMaxGwa" DECIMAL(3,2) NOT NULL DEFAULT 1.45,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_policies_pkey" PRIMARY KEY ("schoolId")
);

CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "roleCode" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL DEFAULT 'SCHOOL',
    "scopeId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- -- Permission registry -------------------------------------------------------
CREATE TABLE "permissions" (
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "role_templates" (
    "id" UUID NOT NULL,
    "mode" "SchoolMode" NOT NULL,
    "roleCode" TEXT NOT NULL,

    CONSTRAINT "role_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_template_permissions" (
    "templateId" UUID NOT NULL,
    "permissionCode" TEXT NOT NULL,

    CONSTRAINT "role_template_permissions_pkey" PRIMARY KEY ("templateId","permissionCode")
);

-- -- Indexes: tenant registry + permission registry ----------------------------
CREATE UNIQUE INDEX "schools_code_key" ON "schools"("code");
CREATE UNIQUE INDEX "memberships_schoolId_userId_key" ON "memberships"("schoolId", "userId");
CREATE INDEX "memberships_userId_status_idx" ON "memberships"("userId", "status");
CREATE UNIQUE INDEX "role_assignments_membershipId_roleCode_key" ON "role_assignments"("membershipId", "roleCode");
CREATE INDEX "role_assignments_schoolId_roleCode_idx" ON "role_assignments"("schoolId", "roleCode");
CREATE UNIQUE INDEX "role_templates_mode_roleCode_key" ON "role_templates"("mode", "roleCode");

-- -- Foreign keys: tenant registry + permission registry -----------------------
ALTER TABLE "school_policies" ADD CONSTRAINT "school_policies_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_template_permissions" ADD CONSTRAINT "role_template_permissions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "role_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_template_permissions" ADD CONSTRAINT "role_template_permissions_permissionCode_fkey" FOREIGN KEY ("permissionCode") REFERENCES "permissions"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- -- School #1: fixed UUID; the pre-1a single-tenant data belongs here. --------
INSERT INTO "schools" ("id", "code", "name")
VALUES ('11111111-1111-4111-8111-111111111111', 'MAIN', 'Main Campus');

-- -- schoolId on every tenant table -------------------------------------------
-- Identity is global (ADR-0002): users carries no schoolId; membership is the
-- link. audit_logs.schoolId stays nullable for platform/system events.

-- student_profiles
ALTER TABLE "student_profiles" ADD COLUMN "schoolId" UUID;
UPDATE "student_profiles" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "student_profiles" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- student_holds
ALTER TABLE "student_holds" ADD COLUMN "schoolId" UUID;
UPDATE "student_holds" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "student_holds" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "student_holds" ADD CONSTRAINT "student_holds_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- audit_logs (nullable: NULL = platform/system chain)
-- The append-only trigger would reject the backfill UPDATE, so it is paused.
ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_no_update";
ALTER TABLE "audit_logs" ADD COLUMN "schoolId" UUID;
UPDATE "audit_logs" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_no_update";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "audit_logs_schoolId_id_idx" ON "audit_logs"("schoolId", "id");

-- idempotency_keys
ALTER TABLE "idempotency_keys" ADD COLUMN "schoolId" UUID;
UPDATE "idempotency_keys" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "idempotency_keys" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- departments
ALTER TABLE "departments" ADD COLUMN "schoolId" UUID;
UPDATE "departments" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "departments" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "departments" ADD CONSTRAINT "departments_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- programs
ALTER TABLE "programs" ADD COLUMN "schoolId" UUID;
UPDATE "programs" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "programs" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "programs" ADD CONSTRAINT "programs_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- curriculum_versions
ALTER TABLE "curriculum_versions" ADD COLUMN "schoolId" UUID;
UPDATE "curriculum_versions" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "curriculum_versions" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "curriculum_versions" ADD CONSTRAINT "curriculum_versions_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- courses
ALTER TABLE "courses" ADD COLUMN "schoolId" UUID;
UPDATE "courses" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "courses" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "courses" ADD CONSTRAINT "courses_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- curriculum_courses
ALTER TABLE "curriculum_courses" ADD COLUMN "schoolId" UUID;
UPDATE "curriculum_courses" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "curriculum_courses" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "curriculum_courses" ADD CONSTRAINT "curriculum_courses_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- course_requisites
ALTER TABLE "course_requisites" ADD COLUMN "schoolId" UUID;
UPDATE "course_requisites" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "course_requisites" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "course_requisites" ADD CONSTRAINT "course_requisites_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- academic_terms
ALTER TABLE "academic_terms" ADD COLUMN "schoolId" UUID;
UPDATE "academic_terms" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "academic_terms" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "academic_terms" ADD CONSTRAINT "academic_terms_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- rooms
ALTER TABLE "rooms" ADD COLUMN "schoolId" UUID;
UPDATE "rooms" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "rooms" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- sections
ALTER TABLE "sections" ADD COLUMN "schoolId" UUID;
UPDATE "sections" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "sections" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "sections" ADD CONSTRAINT "sections_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- section_schedules
ALTER TABLE "section_schedules" ADD COLUMN "schoolId" UUID;
UPDATE "section_schedules" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "section_schedules" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "section_schedules" ADD CONSTRAINT "section_schedules_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- enrollments
ALTER TABLE "enrollments" ADD COLUMN "schoolId" UUID;
UPDATE "enrollments" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "enrollments" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- enrollment_items
ALTER TABLE "enrollment_items" ADD COLUMN "schoolId" UUID;
UPDATE "enrollment_items" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "enrollment_items" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "enrollment_items" ADD CONSTRAINT "enrollment_items_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- fee_definitions
ALTER TABLE "fee_definitions" ADD COLUMN "schoolId" UUID;
UPDATE "fee_definitions" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "fee_definitions" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "fee_definitions" ADD CONSTRAINT "fee_definitions_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- scholarships
ALTER TABLE "scholarships" ADD COLUMN "schoolId" UUID;
UPDATE "scholarships" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "scholarships" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "scholarships" ADD CONSTRAINT "scholarships_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- tuition_assessments
ALTER TABLE "tuition_assessments" ADD COLUMN "schoolId" UUID;
UPDATE "tuition_assessments" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "tuition_assessments" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "tuition_assessments" ADD CONSTRAINT "tuition_assessments_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- grade_sheets
ALTER TABLE "grade_sheets" ADD COLUMN "schoolId" UUID;
UPDATE "grade_sheets" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "grade_sheets" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "grade_sheets" ADD CONSTRAINT "grade_sheets_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- grade_ledger_entries (POSTED rows are frozen by 0002 trigger; pause it for
-- the backfill - the trigger only allows POSTED -> SUPERSEDED transitions).
ALTER TABLE "grade_ledger_entries" DISABLE TRIGGER "grade_ledger_immutable";
ALTER TABLE "grade_ledger_entries" ADD COLUMN "schoolId" UUID;
UPDATE "grade_ledger_entries" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "grade_ledger_entries" ENABLE TRIGGER "grade_ledger_immutable";
ALTER TABLE "grade_ledger_entries" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- grade_rectifications
ALTER TABLE "grade_rectifications" ADD COLUMN "schoolId" UUID;
UPDATE "grade_rectifications" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "grade_rectifications" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "grade_rectifications" ADD CONSTRAINT "grade_rectifications_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- document_requests
ALTER TABLE "document_requests" ADD COLUMN "schoolId" UUID;
UPDATE "document_requests" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "document_requests" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- document_download_events
ALTER TABLE "document_download_events" ADD COLUMN "schoolId" UUID;
UPDATE "document_download_events" SET "schoolId" = '11111111-1111-4111-8111-111111111111' WHERE "schoolId" IS NULL;
ALTER TABLE "document_download_events" ALTER COLUMN "schoolId" SET NOT NULL;
ALTER TABLE "document_download_events" ADD CONSTRAINT "document_download_events_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- -- Per-school unique indexes -------------------------------------------------
-- Global codes become unique per school. serialHash keeps its global unique
-- (a serial can never be reissued anywhere). Course/student internal IDs stay
-- globally unique, so existing partial uniques (active grade entry, active
-- enrollment item) remain valid without schoolId.

DROP INDEX "student_profiles_studentNo_key";
CREATE UNIQUE INDEX "student_profiles_schoolId_studentNo_key" ON "student_profiles"("schoolId", "studentNo");

DROP INDEX "departments_code_key";
CREATE UNIQUE INDEX "departments_schoolId_code_key" ON "departments"("schoolId", "code");

DROP INDEX "programs_code_key";
CREATE UNIQUE INDEX "programs_schoolId_code_key" ON "programs"("schoolId", "code");

DROP INDEX "courses_code_key";
CREATE UNIQUE INDEX "courses_schoolId_code_key" ON "courses"("schoolId", "code");

DROP INDEX "academic_terms_code_key";
CREATE UNIQUE INDEX "academic_terms_schoolId_code_key" ON "academic_terms"("schoolId", "code");

DROP INDEX "academic_terms_schoolYear_termNo_key";
CREATE UNIQUE INDEX "academic_terms_schoolId_schoolYear_termNo_key" ON "academic_terms"("schoolId", "schoolYear", "termNo");

DROP INDEX "rooms_code_key";
CREATE UNIQUE INDEX "rooms_schoolId_code_key" ON "rooms"("schoolId", "code");

DROP INDEX "fee_definitions_code_key";
CREATE UNIQUE INDEX "fee_definitions_schoolId_code_key" ON "fee_definitions"("schoolId", "code");

DROP INDEX "document_requests_serialNo_key";
CREATE UNIQUE INDEX "document_requests_schoolId_serialNo_key" ON "document_requests"("schoolId", "serialNo");

DROP INDEX "idempotency_keys_userId_key_key";
CREATE UNIQUE INDEX "idempotency_keys_schoolId_userId_key_key" ON "idempotency_keys"("schoolId", "userId", "key");

-- -- Double-booking constraints become per-school (INV-2) ----------------------
ALTER TABLE "section_schedules" DROP CONSTRAINT "schedule_room_no_overlap";
ALTER TABLE "section_schedules" ADD CONSTRAINT "schedule_room_no_overlap"
  EXCLUDE USING gist (
    "schoolId" WITH =,
    "termId" WITH =,
    "roomId" WITH =,
    "dayOfWeek" WITH =,
    "timeRange" WITH &&
  );

ALTER TABLE "section_schedules" DROP CONSTRAINT "schedule_instructor_no_overlap";
ALTER TABLE "section_schedules" ADD CONSTRAINT "schedule_instructor_no_overlap"
  EXCLUDE USING gist (
    "schoolId" WITH =,
    "termId" WITH =,
    "instructorId" WITH =,
    "dayOfWeek" WITH =,
    "timeRange" WITH &&
  );

-- -- Row-level security: tenant isolation (ADR-0001) ---------------------------
-- Policy: system context (login/membership resolution, maintenance) OR exact
-- school match. app.current_school_id defaults to the nil UUID for application
-- connections, so a missing GUC yields zero rows (fail closed).
--
-- ENABLE + FORCE: FORCE has no effect on the superuser runtime connection of
-- 1a but protects any future non-superuser owner.

ALTER TABLE "schools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schools" FORCE ROW LEVEL SECURITY;
CREATE POLICY "schools_tenant_isolation" ON "schools"
  USING (current_setting('app.system', true) = 'on' OR "id"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "id"::text = current_setting('app.current_school_id', true));

ALTER TABLE "school_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "school_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "school_policies_tenant_isolation" ON "school_policies"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memberships_tenant_isolation" ON "memberships"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "role_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "role_assignments_tenant_isolation" ON "role_assignments"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "student_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "student_profiles_tenant_isolation" ON "student_profiles"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "student_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "student_holds_tenant_isolation" ON "student_holds"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_keys_tenant_isolation" ON "idempotency_keys"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "departments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "departments_tenant_isolation" ON "departments"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "programs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "programs_tenant_isolation" ON "programs"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "curriculum_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "curriculum_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "curriculum_versions_tenant_isolation" ON "curriculum_versions"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "courses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "courses_tenant_isolation" ON "courses"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "curriculum_courses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "curriculum_courses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "curriculum_courses_tenant_isolation" ON "curriculum_courses"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "course_requisites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_requisites" FORCE ROW LEVEL SECURITY;
CREATE POLICY "course_requisites_tenant_isolation" ON "course_requisites"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "academic_terms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academic_terms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "academic_terms_tenant_isolation" ON "academic_terms"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "rooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rooms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rooms_tenant_isolation" ON "rooms"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sections_tenant_isolation" ON "sections"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "section_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "section_schedules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "section_schedules_tenant_isolation" ON "section_schedules"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "enrollments_tenant_isolation" ON "enrollments"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "enrollment_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollment_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "enrollment_items_tenant_isolation" ON "enrollment_items"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "fee_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fee_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fee_definitions_tenant_isolation" ON "fee_definitions"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "scholarships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scholarships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "scholarships_tenant_isolation" ON "scholarships"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "tuition_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tuition_assessments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tuition_assessments_tenant_isolation" ON "tuition_assessments"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "grade_sheets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grade_sheets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "grade_sheets_tenant_isolation" ON "grade_sheets"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "grade_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grade_ledger_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "grade_ledger_entries_tenant_isolation" ON "grade_ledger_entries"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "grade_rectifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grade_rectifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "grade_rectifications_tenant_isolation" ON "grade_rectifications"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "document_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_requests_tenant_isolation" ON "document_requests"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

ALTER TABLE "document_download_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_download_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_download_events_tenant_isolation" ON "document_download_events"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));

-- -- Application role ----------------------------------------------------------
-- NOBYPASSRLS and non-owner: tenant policies always apply to it. The default
-- GUCs make a context-less connection see nothing (fail closed). Credentials
-- are provisioned per environment (dev-run / tests / docker entrypoint):
--   ALTER ROLE "schoolledger_app" WITH PASSWORD '<secret>';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schoolledger_app') THEN
    CREATE ROLE "schoolledger_app"
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE "schoolledger_app" SET "app.system" = 'off';
ALTER ROLE "schoolledger_app" SET "app.current_school_id" = '00000000-0000-0000-0000-000000000000';

GRANT USAGE ON SCHEMA "public" TO "schoolledger_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "schoolledger_app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "schoolledger_app";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "public" TO "schoolledger_app";
REVOKE ALL ON "_prisma_migrations" FROM "schoolledger_app";

ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "schoolledger_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT USAGE, SELECT ON SEQUENCES TO "schoolledger_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT EXECUTE ON FUNCTIONS TO "schoolledger_app";
