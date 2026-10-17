# SIS Teardown — Reference Study (Phase 0)

Purpose: ground the multi-tenant SIS design in how real school systems actually model
schools, terms, grading, attendance, admissions, fees, and family access — before we
touch the schema. This is the "study" half of "contract-first"; the "decide" half lives
in `docs/adr/` and `docs/institution-modes.md`.

## Method & lawfulness

- **Open-source source study** (read-only; no builds, no execution): four production SIS
  codebases studied at pinned commits by sub-agents, notes kept in `docs/teardown-notes/`.
  All four are copyleft (GPL-2/3, LGPL-3, Apache-2) — treated as **ideas only**; no code,
  schema DDL, or assets are copied into this repo.
- **Public vendor demos** observed with REA (`rea-agents@6.5.0`) browser capture
  (Playwright/CDP against a dedicated headless Chrome): EduPro CMS public demo with
  vendor-published credentials (`demo_teacher` / `demo_student`, `Demo@12345`), accessed
  on 2026-10-17. Only vendor-sanctioned demo accounts were used; screenshots retained in
  `docs/teardown-evidence/`.
- Repros: scenario JSONs + raw evidence under `tools/reference/scenarios/` (gitignored).

| Reference | Version / commit | License | Stack | Why it matters to us |
|---|---|---|---|---|
| Gibbon | v31.0.00 `65f86bf` | GPL-3.0 | PHP 8 / MySQL | Richest K-12 feature surface; form engine, report-card cycles, markbook, finance |
| openSIS Classic | CE 9.3 `5d546f2` | GPL-2.0 | PHP / MySQL | True multi-school + multi-year columns; grade posting windows; GPA/rank pipeline |
| Fedena | `68a84ac` (2011-13 era) | Apache-2.0 | Rails 2.x | Exam weightage cache, fee collection copy-on-create, CCE, HR/payroll |
| OpenEduCat ERP | Odoo 19 `46a5d7d` | LGPL-3 | Odoo / Python | Cleanest admissions→enrollment cascade, installment fees, sheet-based attendance, portal child linkage |
| EduPro CMS (demo) | live `eduprocms.kesug.com` | commercial demo | WordPress | Hosted K-12 portal IA for teacher/student dashboards (screenshots) |

Detail files: `docs/teardown-notes/gibbon.md`, `opensis.md`, `fedena.md`, `openeducat.md`.

## Domain map — what each area must cover, and what to take

| Domain | Feature floor (from references) | What we take forward |
|---|---|---|
| Academics / catalog | Courses, subjects, programs, departments, grade levels, scales | Catalog → offering → membership separation (all 4; Gibbon `Course`/`CourseClass`/`CourseClassPerson` is the cleanest shape) |
| Academic time | School years, terms/semesters/quarters, marking periods, calendars, special days | First-class school year → term tree as **data** with posting windows (openSIS) — stronger than date-carrying batches (Fedena/OpenEduCat weakness) |
| Enrollment & placement | Year-level placement, sections, reserves/drops, transfer history | Placement rows with dates + status codes, never booleans; drop ≠ delete (openSIS `dropped`, Gibbon `status`); unit-load governance (OpenEduCat subject registration) |
| Scheduling | Period grid, timetable versions, substitutions, room/faculty conflicts | Weekly period grid as core (HE); cycle-day timetable as a K-12 toggle (Gibbon); conflict suggestion + versioning (OpenEduCat settings-gated checks, Fedena period entries) |
| Assessment | Gradebook (weighted components), exam pipeline, scales, report cards, transcripts | Compute-on-read markbook (Gibbon) + **posted snapshots** for transcripts (openSIS `student_report_card_grades`); report-card cycles/scopes/criteria as data (Gibbon); staged exam visibility `draft → published → results` (Fedena) |
| Attendance | Daily vs subject-wise, codes, minutes, session completion | Raw events + derived summaries (Gibbon log rows; openSIS minutes→state_value arithmetic); sheet documents with state machine (OpenEduCat); dual mode switch validated by Fedena+OpenEduCat |
| Admissions | Online forms, pipeline states, fees, offers, waitlists | Gibbon form builder + staged processors (Check→Submit→Accept) creating family/student/invoice in one cascade; OpenEduCat intake caps (min age, max count) |
| Student records | Demographics, contacts/guardians, medical, notes, alerts, custom fields | Single person identity + guardian graph with per-child access (Gibbon family; OpenEduCat `child_ids` portal rule); typed custom-field definitions + JSON values (Gibbon), **not** EAV sprawl (openSIS) |
| Family/portal | Parent + student portals, per-child visibility | One identity, many roles, role switcher (Gibbon); parent domain rules keyed off guardianship links (OpenEduCat) |
| Billing / fees | Fee plans, installments, discounts, receipts, online payment | Installment plan that must sum to 100% (OpenEduCat) + collection copy-on-create so history never mutates (Fedena); polymorphic payment attach (Gibbon); we add a real ledger + idempotent webhooks (none of the references have one) |
| Communication | Announcements, messaging, SMS/email, notification events | Outbox queue + listener rules on relative dates (Gibbon notification events); messenger targeting by role/class/group; receipts |
| Reporting | Report cards, transcripts, honor roll, attendance summaries, letters | Cycle-driven report cards (Gibbon), GPA/rank pipeline as computed tables (openSIS); fillable-PDF trick as a print-perfect fallback (Fedena FDF, openSIS `FDFReportCards`) |
| Pastoral / activities (K-12) | Behaviour, first aid, SEN/IN, houses, activities, eligibility, transport | Mode-gated modules in Phase 9; keep entities out of core HE schema; eligibility depends on attendance so it comes after attendance exists |
| Admin / config | Settings scoping, roles/permissions, rollover, audit | Settings scoped **tenant (+school/term)** (openSIS `program_config` granularity — Gibbon's global-only is weak); explicit rollover with lineage, no destructive delete-reinsert (anti-pattern from openSIS) |

## Data-model doctrine (adopt)

1. **One identity, many roles.** A single `User` authenticates; roles are assignments
   (`Membership` per school + role rows), never boolean columns (Fedena) or separate
   student/staff tables (openSIS), never hardcoded profile IDs.
2. **Tenant + time are columns of record.** `schoolId` on every operational table;
   academic year/term as references to real rows with dates and posting windows. No
   `syear` literals baked into rollover copies (openSIS anti-pattern), no year-less
   batches (Fedena/OpenEduCat weakness).
3. **Catalog ≠ offering ≠ membership.** `Course` → `Section` → `Enrollment` rows with
   start/end dates, status codes, and history. Electives/unit loads resolved through an
   explicit registration step (OpenEduCat) rather than mutating membership.
4. **Grades are data, not enums.** Named scales with ordered bands (min/max %,
   validation no-overlap — OpenEduCat) reused by every grading surface; HE adds GPA
   variants and credit weighting on top; transcript = posted, immutable snapshot rows.
5. **Events + derived state.** Attendance and any physical presence recorded as raw
   events with context ("who took it, when, which scope"), summaries derived by job
   (minutes math, state values); sheet documents get state machines for auditability.
6. **Maker–checker for identity edits.** Family/adult upserts write shadow updates that
   staff approve (Gibbon Data Updater) — mirrors our audit chain discipline.
7. **Completion tracking is a feature.** `attendance_completed` / `grades_completed`
   style rows + "missing X" dashboards (openSIS) to chase unposted work; we already have
   grading submit/verify — extend the pattern.
8. **Config is scoped.** Defaults per tenant, overridable per school/term where paths
   differ (GPA scale, attendance mode, currency, term structure); never env-only.
9. **Documents are versioned artifacts.** Reports/exports are generated files with DB
   archive index (Gibbon), re-deliverable; print-perfect form-fill path reserved for
   statutory documents (report cards, forms).
10. **Money moves as ledger entries.** Even fee-only scope: every payment/receipt is an
    append-only row with idempotency keys; never `is_paid` booleans (Fedena/OpenEduCat
    both show the drift this causes).

## Workflow patterns to copy (with source)

1. Admission→enrollment cascade in one transaction: application accept creates student +
   enrollment + fee installments + seeded subject registration (OpenEduCat; Gibbon Accept
   processor).
2. Grade posting windows enforced centrally from marking-period data (openSIS `post_start_date`/
   `post_end_date` via `AllowEdit`; reconcile with our step-up verify flow).
3. Weighted aggregation with compute-on-read for live views + materialized snapshots for
   official documents (Gibbon markbook + openSIS posted snapshots; Fedena's
   `grouped_exam_reports` shows the cache trade-off).
4. Attendance: prefill Present then exceptions; session-completion rows; blocking on
   non-school days; kiosk self-registration as a later add (Gibbon).
5. Report cards as cycles → scopes → criteria → values with a proofreading pass and
   batch PDF generation + archive (Gibbon; statutory print path via form-fill).
6. Fee collection created by copying a template so later template edits never rewrite
   history; discounts stack with a 100% cap (Fedena).
7. Installment plans fix their own arithmetic: lines sum to exactly 100% (OpenEduCat).
8. Notification listeners on relative dates ("fee due in N days", "exam soon") driving an
   outbox with delivery receipts (Gibbon).
9. Role/year switcher for staff (view-as student/parent, browse past terms) built on the
   permission registry from day one (Gibbon; expensive to retrofit).
10. Explicit rollover with lineage (`rollover_id` chains, history tables) — but as a
    planned, reversible migration job with dry-run, not delete-reinsert (openSIS lesson).
11. Timetable conflict checks behind policy toggles with test mode (OpenEduCat params,
    openSIS scheduler test mode) — same philosophy as our feature flags.
12. One calendar feed per user assembled from polymorphic event sources (exams, fee dues,
    holidays) with scope flags (Fedena) — feeds our dashboard "week" element.

## Anti-patterns to avoid (all four codes)

- Columns on every row naming the year literally + destructive rollover (openSIS).
- Multi-tenant columns that no code path actually scopes (Fedena `school_id`; OpenEduCat
  `company_id` on 12 of N models) — either scope or don't; we scope with RLS + tests.
- ACL keyed on URL strings incl. query params (openSIS `profile_exceptions`), hardcoded
  profile IDs (3/4) in code, permissive default-permission seeding (Gibbon) — our
  permission registry is data-driven and test-covered.
- Separate student/staff auth tables; parents hidden in staff (openSIS); boolean role
  columns (Fedena); account provisioning with predictable passwords (`p{admission_no}`).
- Grade scales as enums or min-score-only bands without overlap validation (both).
- Duplicate `archived_*` twin tables and string-interpolated SQL everywhere (Fedena);
  EAV custom fields per entity (openSIS) — typed definitions + JSON value columns instead.
- Stale `schema.rb` vs migrations divergence (Fedena) — our Prisma migrations are the
  single truth (no manual SQL drift).
- Homegrown invoice tables without accounting semantics (Gibbon finance is
  invoice-centric) — we separate receivables/ledger from provider payment metadata.
- Report generation synchronous inside request paths with fat models (Fedena) — ours is
  queue-first (documents worker pattern already proven).

## Demo IA captures (EduPro CMS, 2026-10-17)

Teacher dashboard (`docs/teardown-evidence/edupro-teacher-dashboard.png`):
- Nav: Dashboard · Announcements · Downloads · Timetable · Assignments (Create, Submissions) · Class Teacher · Leave Request
- Widgets: Assigned Subjects/Classes, Recent Assignment Submissions, Latest Announcements, Latest Downloads, Quick Access cards.
- Notable: class-teacher workspace consolidates daily attendance, score review, report-card prep; leave requests are a teacher self-service flow.

Student dashboard (`docs/teardown-evidence/edupro-student-dashboard.png`):
- Nav: Dashboard · Announcements · Downloads · Timetable · Assignments · Attendance · Results · Fees
- Widgets: Latest Announcements, Latest Downloads, Fees & Payment Status, Published Results, Attendance details table (Date · Class · Session/Term · Status · Remarks).
- Notable: attendance surfaced as a compact ledger (close to our ledger aesthetic); session/term label shown per row ("2025/2026 / Third Term") — validated our `2026–1st sem` label approach.

Takeaways: the portal nav floor for K-12 roles is **8 items or fewer**; dashboard = 4–6
glanceable widgets; periods/terms always visible in context. Our student portal already
matches the lower half of this map; teacher/family consoles in later phases should keep
the same density discipline.

## Implications for our build (locked next steps)

- Encoded as ADRs: `docs/adr/0001`–`0007` (tenancy, identity, academic structure, audit,
  notifications, payments, self-hosted packaging) and the mode matrix in
  `docs/institution-modes.md`.
- Phase 1a schema work uses the doctrine rules 1–4 and 8 as acceptance criteria.
- Regression bar: the existing 84-check walkthrough must stay green through every schema
  phase (single-school seed remains as "school #1").
