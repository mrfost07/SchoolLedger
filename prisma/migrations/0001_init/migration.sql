-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'INSTRUCTOR', 'PROGRAM_CHAIR', 'REGISTRAR', 'CASHIER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "HoldType" AS ENUM ('FINANCIAL', 'DISCIPLINARY', 'DOCUMENTARY');

-- CreateEnum
CREATE TYPE "CurriculumStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RequisiteType" AS ENUM ('PREREQUISITE', 'COREQUISITE', 'CONCURRENT');

-- CreateEnum
CREATE TYPE "TermStatus" AS ENUM ('PLANNING', 'ENROLLMENT', 'ADD_DROP', 'ONGOING', 'GRADING', 'CLOSED');

-- CreateEnum
CREATE TYPE "SectionStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ENROLLED', 'DROPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EnrollmentItemStatus" AS ENUM ('ENROLLED', 'WAITLISTED', 'DROPPED');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('ASSESSED', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "FeeCategory" AS ENUM ('TUITION', 'LAB', 'MISC', 'OTHER');

-- CreateEnum
CREATE TYPE "GradeSheetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'VERIFIED', 'POSTED');

-- CreateEnum
CREATE TYPE "GradeEntryStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'VERIFIED', 'POSTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RectificationStatus" AS ENUM ('PENDING', 'CHAIR_ENDORSED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('COR', 'GRADE_SLIP', 'TOR_UNOFFICIAL', 'TOR_OFFICIAL', 'CERT_GRADES', 'CERT_GOOD_MORAL', 'CERT_ENROLLMENT');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "roles" "Role"[],
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "totpSecret" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "studentNo" TEXT NOT NULL,
    "yearLevel" INTEGER NOT NULL DEFAULT 1,
    "programId" UUID NOT NULL,
    "curriculumVersionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_holds" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "type" "HoldType" NOT NULL,
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "entryHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "statusCode" INTEGER,
    "responseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "degreeTitle" TEXT NOT NULL,
    "departmentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_versions" (
    "id" UUID NOT NULL,
    "programId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitsRequired" INTEGER NOT NULL,
    "status" "CurriculumStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "curriculum_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lectureUnits" INTEGER NOT NULL,
    "labUnits" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curriculum_courses" (
    "id" UUID NOT NULL,
    "curriculumVersionId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "yearLevel" INTEGER NOT NULL,
    "termNo" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "curriculum_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_requisites" (
    "id" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "requiredCourseId" UUID NOT NULL,
    "type" "RequisiteType" NOT NULL,
    "minGrade" DECIMAL(3,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_requisites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_terms" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "schoolYear" INTEGER NOT NULL,
    "termNo" INTEGER NOT NULL,
    "status" "TermStatus" NOT NULL DEFAULT 'PLANNING',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "enrollmentStartAt" TIMESTAMP(3) NOT NULL,
    "addDropEndAt" TIMESTAMP(3) NOT NULL,
    "gradingStartAt" TIMESTAMP(3) NOT NULL,
    "gradingEndAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academic_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "building" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "instructorId" UUID,
    "maxCapacity" INTEGER NOT NULL,
    "enrolledCount" INTEGER NOT NULL DEFAULT 0,
    "waitlistCount" INTEGER NOT NULL DEFAULT 0,
    "status" "SectionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_schedules" (
    "id" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "instructorId" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "section_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment_items" (
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "status" "EnrollmentItemStatus" NOT NULL,
    "unitsAtReservation" DECIMAL(4,1) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrolledAt" TIMESTAMP(3),
    "droppedAt" TIMESTAMP(3),

    CONSTRAINT "enrollment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_definitions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "FeeCategory" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "perUnit" BOOLEAN NOT NULL DEFAULT false,
    "programId" UUID,
    "courseId" UUID,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),

    CONSTRAINT "fee_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarships" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),

    CONSTRAINT "scholarships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tuition_assessments" (
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "status" "AssessmentStatus" NOT NULL DEFAULT 'ASSESSED',
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "breakdown" JSONB NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "tuition_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_sheets" (
    "id" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "status" "GradeSheetStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedById" UUID,
    "verifiedById" UUID,
    "postedById" UUID,
    "submittedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "postedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_ledger_entries" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "sheetId" UUID NOT NULL,
    "status" "GradeEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "value" DECIMAL(3,2),
    "isInc" BOOLEAN NOT NULL DEFAULT false,
    "incDeadlineAt" TIMESTAMP(3),
    "prevEntryId" UUID,
    "prevHash" TEXT,
    "entryHash" TEXT,
    "rectificationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_rectifications" (
    "id" UUID NOT NULL,
    "targetEntryId" UUID NOT NULL,
    "status" "RectificationStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "proposedValue" DECIMAL(3,2),
    "proposedIsInc" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" UUID NOT NULL,
    "endorsedById" UUID,
    "approvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "grade_rectifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_requests" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "termId" UUID,
    "status" "DocumentStatus" NOT NULL DEFAULT 'QUEUED',
    "requestedById" UUID,
    "serialNo" TEXT,
    "serialHash" TEXT,
    "snapshot" JSONB,
    "snapshotHash" TEXT,
    "signature" TEXT,
    "storageKey" TEXT,
    "fileSize" INTEGER,
    "pageCount" INTEGER,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "document_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_download_events" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "actorId" UUID,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_download_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_userId_key" ON "student_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "student_profiles_studentNo_key" ON "student_profiles"("studentNo");

-- CreateIndex
CREATE INDEX "student_holds_studentId_type_idx" ON "student_holds"("studentId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_entryHash_key" ON "audit_logs"("entryHash");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_resourceType_resourceId_idx" ON "audit_logs"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_userId_key_key" ON "idempotency_keys"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "programs_code_key" ON "programs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_versions_programId_version_key" ON "curriculum_versions"("programId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "courses_code_key" ON "courses"("code");

-- CreateIndex
CREATE INDEX "curriculum_courses_curriculumVersionId_yearLevel_termNo_idx" ON "curriculum_courses"("curriculumVersionId", "yearLevel", "termNo");

-- CreateIndex
CREATE UNIQUE INDEX "curriculum_courses_curriculumVersionId_courseId_key" ON "curriculum_courses"("curriculumVersionId", "courseId");

-- CreateIndex
CREATE INDEX "course_requisites_requiredCourseId_idx" ON "course_requisites"("requiredCourseId");

-- CreateIndex
CREATE UNIQUE INDEX "course_requisites_courseId_requiredCourseId_type_key" ON "course_requisites"("courseId", "requiredCourseId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "academic_terms_code_key" ON "academic_terms"("code");

-- CreateIndex
CREATE UNIQUE INDEX "academic_terms_schoolYear_termNo_key" ON "academic_terms"("schoolYear", "termNo");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE INDEX "sections_termId_idx" ON "sections"("termId");

-- CreateIndex
CREATE INDEX "sections_instructorId_idx" ON "sections"("instructorId");

-- CreateIndex
CREATE UNIQUE INDEX "sections_termId_courseId_sectionCode_key" ON "sections"("termId", "courseId", "sectionCode");

-- CreateIndex
CREATE INDEX "section_schedules_sectionId_idx" ON "section_schedules"("sectionId");

-- CreateIndex
CREATE INDEX "section_schedules_termId_roomId_idx" ON "section_schedules"("termId", "roomId");

-- CreateIndex
CREATE INDEX "section_schedules_termId_instructorId_idx" ON "section_schedules"("termId", "instructorId");

-- CreateIndex
CREATE INDEX "enrollments_termId_status_idx" ON "enrollments"("termId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_studentId_termId_key" ON "enrollments"("studentId", "termId");

-- CreateIndex
CREATE INDEX "enrollment_items_enrollmentId_sectionId_idx" ON "enrollment_items"("enrollmentId", "sectionId");

-- CreateIndex
CREATE INDEX "enrollment_items_sectionId_status_createdAt_idx" ON "enrollment_items"("sectionId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "fee_definitions_code_key" ON "fee_definitions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "scholarships_studentId_code_key" ON "scholarships"("studentId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "tuition_assessments_enrollmentId_key" ON "tuition_assessments"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "grade_sheets_sectionId_key" ON "grade_sheets"("sectionId");

-- CreateIndex
CREATE INDEX "grade_sheets_termId_status_idx" ON "grade_sheets"("termId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "grade_ledger_entries_entryHash_key" ON "grade_ledger_entries"("entryHash");

-- CreateIndex
CREATE INDEX "grade_ledger_entries_studentId_termId_idx" ON "grade_ledger_entries"("studentId", "termId");

-- CreateIndex
CREATE INDEX "grade_ledger_entries_studentId_courseId_status_idx" ON "grade_ledger_entries"("studentId", "courseId", "status");

-- CreateIndex
CREATE INDEX "grade_ledger_entries_sheetId_idx" ON "grade_ledger_entries"("sheetId");

-- CreateIndex
CREATE INDEX "grade_ledger_entries_sectionId_idx" ON "grade_ledger_entries"("sectionId");

-- CreateIndex
CREATE INDEX "grade_rectifications_targetEntryId_status_idx" ON "grade_rectifications"("targetEntryId", "status");

-- CreateIndex
CREATE INDEX "grade_rectifications_status_idx" ON "grade_rectifications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "document_requests_serialNo_key" ON "document_requests"("serialNo");

-- CreateIndex
CREATE UNIQUE INDEX "document_requests_serialHash_key" ON "document_requests"("serialHash");

-- CreateIndex
CREATE INDEX "document_requests_studentId_type_idx" ON "document_requests"("studentId", "type");

-- CreateIndex
CREATE INDEX "document_requests_status_idx" ON "document_requests"("status");

-- CreateIndex
CREATE INDEX "document_download_events_documentId_createdAt_idx" ON "document_download_events"("documentId", "createdAt");

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_curriculumVersionId_fkey" FOREIGN KEY ("curriculumVersionId") REFERENCES "curriculum_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_holds" ADD CONSTRAINT "student_holds_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_versions" ADD CONSTRAINT "curriculum_versions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_courses" ADD CONSTRAINT "curriculum_courses_curriculumVersionId_fkey" FOREIGN KEY ("curriculumVersionId") REFERENCES "curriculum_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "curriculum_courses" ADD CONSTRAINT "curriculum_courses_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_requisites" ADD CONSTRAINT "course_requisites_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_requisites" ADD CONSTRAINT "course_requisites_requiredCourseId_fkey" FOREIGN KEY ("requiredCourseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_termId_fkey" FOREIGN KEY ("termId") REFERENCES "academic_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_instructorId_fkey" FOREIGN KEY ("instructorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_schedules" ADD CONSTRAINT "section_schedules_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_schedules" ADD CONSTRAINT "section_schedules_termId_fkey" FOREIGN KEY ("termId") REFERENCES "academic_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_schedules" ADD CONSTRAINT "section_schedules_instructorId_fkey" FOREIGN KEY ("instructorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_schedules" ADD CONSTRAINT "section_schedules_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_termId_fkey" FOREIGN KEY ("termId") REFERENCES "academic_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_items" ADD CONSTRAINT "enrollment_items_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment_items" ADD CONSTRAINT "enrollment_items_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_definitions" ADD CONSTRAINT "fee_definitions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_definitions" ADD CONSTRAINT "fee_definitions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarships" ADD CONSTRAINT "scholarships_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tuition_assessments" ADD CONSTRAINT "tuition_assessments_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_sheets" ADD CONSTRAINT "grade_sheets_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_sheets" ADD CONSTRAINT "grade_sheets_termId_fkey" FOREIGN KEY ("termId") REFERENCES "academic_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_sheets" ADD CONSTRAINT "grade_sheets_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_sheets" ADD CONSTRAINT "grade_sheets_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_sheets" ADD CONSTRAINT "grade_sheets_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_termId_fkey" FOREIGN KEY ("termId") REFERENCES "academic_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "grade_sheets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_prevEntryId_fkey" FOREIGN KEY ("prevEntryId") REFERENCES "grade_ledger_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_ledger_entries" ADD CONSTRAINT "grade_ledger_entries_rectificationId_fkey" FOREIGN KEY ("rectificationId") REFERENCES "grade_rectifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_rectifications" ADD CONSTRAINT "grade_rectifications_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_rectifications" ADD CONSTRAINT "grade_rectifications_endorsedById_fkey" FOREIGN KEY ("endorsedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_rectifications" ADD CONSTRAINT "grade_rectifications_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_rectifications" ADD CONSTRAINT "grade_rectifications_targetEntryId_fkey" FOREIGN KEY ("targetEntryId") REFERENCES "grade_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_requests" ADD CONSTRAINT "document_requests_termId_fkey" FOREIGN KEY ("termId") REFERENCES "academic_terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_download_events" ADD CONSTRAINT "document_download_events_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

