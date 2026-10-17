# ADR-0003: Academic structure — first-class time, catalog/offering/membership, dated placement

- Status: accepted (Phase 0, 2026-10-17)
- Evidence: `sis-teardown.md` doctrine 2–4; `opensis.md` (year/term rows + posting
  windows), `gibbon.md` (Year→Term→SpecialDay; Course→Class→Person), `fedena.md` /
  `openeducat.md` (no first-class year; date-carrying batches)

## Context

Current schema has `Term` as a code string (`2025-2A`) and enrollment statuses bolted to
students. The references show two viable futures: rows-with-integrity (openSIS: year/
semester/quarter/marking-period tree with posting windows; Gibbon: year→terms→special
days) or date-carrying names (Fedena batches, OpenEduCat batches). Only the former
survives multi-year, multi-mode growth.

## Decision

- **Academic time is data**: `AcademicYear` (school-scoped, status Past/Current/Upcoming,
  first/last day) → `AcademicTerm` (nested: semester → term/quarter, with `kind`,
  ordering, and **posting windows** `gradePostOpensAt/ClosesAt` semantics) →
  `CalendarException` (holidays, closures, timetable exceptions, per scope).
- **Catalog ≠ offering ≠ membership**:
  - `Course` (subject identity, department, credits/weight) — school-scoped.
  - `Section` (term-scoped offering: capacity, schedule pattern, instructors, mode flags
    like `doesAttendance`) — the unit students reserve.
  - `Enrollment` (membership row: student × section, status `RESERVED|ENROLLED|DROPPED|
    COMPLETED`, with `startDate/endDate`, drop code, waitlist position) — never boolean
    flags on the person.
- **Placement is dated history**: student's year-level/homeroom placement (H12 concepts)
  is a `Placement` row chain (from/to dates, source: promotion|transfer|initial), not a
  mutable field alone; current value derived, history preserved.
- **Rollover is explicit and reversible**: a `RolloverJob` copies structure forward with
  lineage IDs and a dry-run mode; never delete-reinsert (openSIS anti-pattern).
- Term/period references replace string codes; the existing `2025-2A` fixture is seeded
  as a term row in School #1 so the regression walkthrough stays green.

## Consequences

- Every module touching "current term" reads the term row (caching allowed, invalidation
  via term change event).
- Grading posting windows drop out of ad-hoc checks and become policy reads (mirrors
  openSIS `AllowEdit` centralization; interacts with our step-up verify flow).
- K-12 promotion (Phase 9) builds on `Placement` without schema surgery.

## Alternatives rejected

- Keep code-string terms: blocks multi-year history, posting windows, and K-12 reports.
- Add `academic_year` literals per row (openSIS): integrity and rollover costs.
