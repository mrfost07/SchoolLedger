-- =============================================================================
-- 0002_hardening - database-layer invariants
--   INV-1 capacity        : CHECK enrolledCount <= maxCapacity
--   INV-2 double booking  : btree_gist EXCLUDE constraints (room / instructor)
--   INV-3 DAG             : CHECK courseId <> requiredCourseId (acyclicity in svc)
--   INV-4 one grade entry : partial unique index
--   INV-5 grade immutable : POSTED rows frozen by trigger
--   INV-6 audit append    : audit_logs UPDATE/DELETE rejected by trigger
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -- Sections: capacity and counter bounds (INV-1) ----------------------------
ALTER TABLE "sections"
  ADD CONSTRAINT "sections_capacity_bounds"
  CHECK ("enrolledCount" >= 0 AND "enrolledCount" <= "maxCapacity");

ALTER TABLE "sections"
  ADD CONSTRAINT "sections_waitlist_non_negative"
  CHECK ("waitlistCount" >= 0);

ALTER TABLE "sections"
  ADD CONSTRAINT "sections_capacity_positive"
  CHECK ("maxCapacity" > 0);

-- -- Schedules: sanity + generated int4range + GiST exclusions (INV-2) --------
ALTER TABLE "section_schedules"
  ADD CONSTRAINT "schedule_day_bounds"
  CHECK ("dayOfWeek" BETWEEN 1 AND 7);

ALTER TABLE "section_schedules"
  ADD CONSTRAINT "schedule_time_bounds"
  CHECK ("startMin" >= 0 AND "endMin" <= 1440 AND "endMin" > "startMin");

ALTER TABLE "section_schedules"
  ADD COLUMN "timeRange" int4range
  GENERATED ALWAYS AS (int4range("startMin", "endMin", '[)')) STORED;

-- A room cannot host two overlapping schedules in the same term/day.
ALTER TABLE "section_schedules"
  ADD CONSTRAINT "schedule_room_no_overlap"
  EXCLUDE USING gist (
    "termId" WITH =,
    "roomId" WITH =,
    "dayOfWeek" WITH =,
    "timeRange" WITH &&
  );

-- An instructor cannot teach two overlapping schedules in the same term/day.
ALTER TABLE "section_schedules"
  ADD CONSTRAINT "schedule_instructor_no_overlap"
  EXCLUDE USING gist (
    "termId" WITH =,
    "instructorId" WITH =,
    "dayOfWeek" WITH =,
    "timeRange" WITH &&
  );

-- -- Course requisites: no self reference (INV-3, cycles enforced in service) --
ALTER TABLE "course_requisites"
  ADD CONSTRAINT "requisite_no_self_reference"
  CHECK ("courseId" <> "requiredCourseId");

-- -- Grade ledger: value bounds + one active entry (INV-4) --------------------
ALTER TABLE "grade_ledger_entries"
  ADD CONSTRAINT "grade_value_bounds"
  CHECK ("value" IS NULL OR ("value" >= 1.00 AND "value" <= 5.00));

ALTER TABLE "grade_ledger_entries"
  ADD CONSTRAINT "grade_inc_shape"
  CHECK (NOT "isInc" OR "value" IS NULL);

CREATE UNIQUE INDEX "grade_ledger_active_entry_unique"
  ON "grade_ledger_entries" ("studentId", "courseId", "termId")
  WHERE status <> 'SUPERSEDED';

-- -- Enrollment items: only one non-dropped row per (enrollment, section) -----
CREATE UNIQUE INDEX "enrollment_items_active_unique"
  ON "enrollment_items" ("enrollmentId", "sectionId")
  WHERE status <> 'DROPPED';

-- -- Grade immutability (INV-5) -----------------------------------------------
-- POSTED rows may only transition to SUPERSEDED (and only via the rectification
-- service, which inserts a linked version+1 row). Every other update is fatal.
CREATE OR REPLACE FUNCTION enforce_grade_immutability() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'POSTED' THEN
    IF NEW.status = 'SUPERSEDED' AND NEW."value" IS NOT DISTINCT FROM OLD."value"
       AND NEW."isInc" IS NOT DISTINCT FROM OLD."isInc"
       AND NEW."studentId" IS NOT DISTINCT FROM OLD."studentId"
       AND NEW."courseId" IS NOT DISTINCT FROM OLD."courseId"
       AND NEW."termId" IS NOT DISTINCT FROM OLD."termId"
       AND NEW."sectionId" IS NOT DISTINCT FROM OLD."sectionId"
       AND NEW."sheetId" IS NOT DISTINCT FROM OLD."sheetId"
       AND NEW."entryHash" IS NOT DISTINCT FROM OLD."entryHash"
       AND NEW.version IS NOT DISTINCT FROM OLD.version
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'grade_ledger_entries: POSTED rows are immutable - use the rectification workflow';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER grade_ledger_immutable
  BEFORE UPDATE ON "grade_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION enforce_grade_immutability();

-- The ledger is append-only except for DRAFT rows (removed before submission).
CREATE OR REPLACE FUNCTION block_ledger_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'grade_ledger_entries: non-DRAFT rows cannot be deleted (append-only ledger)';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER grade_ledger_no_delete
  BEFORE DELETE ON "grade_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION block_ledger_delete();

-- -- Audit log append-only (INV-6) --------------------------------------------
CREATE OR REPLACE FUNCTION block_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION block_audit_mutation();

-- -- Tuition assessments: frozen breakdown once computed (BSL-205) ------------
CREATE OR REPLACE FUNCTION enforce_assessment_immutability() RETURNS trigger AS $$
BEGIN
  IF NEW."breakdown" IS DISTINCT FROM OLD."breakdown"
     OR NEW."totalAmount" IS DISTINCT FROM OLD."totalAmount"
     OR NEW."snapshotHash" IS DISTINCT FROM OLD."snapshotHash"
     OR NEW."enrollmentId" IS DISTINCT FROM OLD."enrollmentId"
  THEN
    RAISE EXCEPTION 'tuition_assessments: breakdown is immutable once assessed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assessment_immutable
  BEFORE UPDATE ON "tuition_assessments"
  FOR EACH ROW EXECUTE FUNCTION enforce_assessment_immutability();
