-- Phase 2 — identity & access lifecycle.
--
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- 1) Role templates gain optional per-school overrides: a row with "schoolId"
--    set replaces the school-less default row (schoolId IS NULL) for that
--    school only. The old (mode, roleCode) unique must go: Postgres treats
--    NULLs as distinct, so defaults and overrides each get a partial index.
ALTER TABLE "role_templates" ADD COLUMN "schoolId" UUID;

ALTER TABLE "role_templates" ADD CONSTRAINT "role_templates_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "role_templates_mode_roleCode_key";

CREATE UNIQUE INDEX "role_templates_default_mode_role_key"
  ON "role_templates" ("mode", "roleCode") WHERE "schoolId" IS NULL;
CREATE UNIQUE INDEX "role_templates_school_role_key"
  ON "role_templates" ("schoolId", "roleCode") WHERE "schoolId" IS NOT NULL;

-- 2) Invitations (ADR-0002 provisioning): raw token shown once, only its
--    SHA-256 hash stored; binds the invitee's membership + roles at accept.
CREATE TABLE "invitations" (
  "id" UUID NOT NULL,
  "schoolId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "roles" "Role"[],
  "tokenHash" TEXT NOT NULL,
  "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
  "invitedById" UUID NOT NULL,
  "acceptedUserId" UUID,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");
CREATE INDEX "invitations_schoolId_status_idx" ON "invitations"("schoolId", "status");
CREATE INDEX "invitations_schoolId_email_idx" ON "invitations"("schoolId", "email");

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptedUserId_fkey"
  FOREIGN KEY ("acceptedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security (pattern from 0003_tenancy).
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invitations_tenant_isolation" ON "invitations"
  USING (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true))
  WITH CHECK (current_setting('app.system', true) = 'on' OR "schoolId"::text = current_setting('app.current_school_id', true));
