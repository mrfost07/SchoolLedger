# Institution Modes — HE vs K-12 (design lock, Phase 0)

Decision: one product, one core schema, two **modes** (`HE`, `K12`) selected per school
(`School.mode`), with behavior gated by mode + `SchoolPolicy`. No forks, no parallel
codebases. K-12 mode is designed now (this document) and built in Phase 9; HE ships
first. Reference evidence: `docs/teardown-notes/*` (Gibbon/openSIS = K-12 depth,
OpenEduCat = HE depth, Fedena = both lessons) and `docs/sis-teardown.md` doctrine.

## Mode vs policy vs capability

- **Mode** (`School.mode`): structural differences that change workflows — enrollment
  promotion, attendance shape, grading culture, guardianship defaults.
- **Policy** (`SchoolPolicy`, per school/term): configurable values — passing mark,
  scales, INC rules, currency, term structure, visibility rules. Existing env policy
  knobs in `src/config/env.ts` migrate here (Phase 1a).
- **Feature gates**: K-12-only modules (behaviour, first aid, activities, eligibility)
  are default-off capabilities toggled per school; HE-only (thesis, units/load) exist
  but default off in K12. Gates are data, seeded from mode templates.

## Capability matrix

| Dimension | HE (Phase 1–8 core) | K12 (Phase 9) | Notes / source lesson |
|---|---|---|---|
| Org hierarchy | School → department (subject tree) | School → grade level → homeroom/form group; houses optional | openSIS grade levels + sections; Gibbon form groups + houses |
| Academic time | School year → 2 semesters → terms; program-based | School year → 3 terms/quarters; marking periods with posting windows | First-class year/term rows (openSIS), not date-carrying batches |
| Catalog | Program → course → section | Subject → class section (per grade level) | Catalog/offering/membership split serves both |
| Enrollment | Reserve sections, unit load/min–max units, prerequisites, drop with codes | Placement per year into grade + section; promotion + rollover | openSIS drop codes; Gibbon `status` + rollOrder; OpenEduCat registration approval |
| Promotion | Term-to-term continuation; graduation audit | Year-end promotion, form-group→next links, retention | Gibbon `formGroupIDNext`; openSIS rollover (we make it explicit + reversible) |
| Scheduling | Weekly period grid; conflict detection faculty/room/section | Cycle days (Day 1..N) over period grid; substitutions | Gibbon cycle-day timetable = K12 toggle; weekly grid stays core |
| Attendance | Per-session attendance optional per section | Homeroom daily + per-period; minutes/% day math; state codes | openSIS minutes→state_value; OpenEduCat sheet state machine; dual mode switch |
| Assessment | Weighted components → computed grade → posted transcript + GPA/credits | CA/tests/exams per term → report card with comments/conduct; ranking/honor roll | Gibbon markbook compute-on-read + openSIS posted snapshots; Fedena CCE/rank |
| Report cards | Transcript/grade report per term (statutory print) | Per-term report card cycles scopes/criteria + teacher comments, proof pass | Gibbon cycles/scopes/criteria modeled as data |
| Guardians | Optional; adult learners self-manage | First-class: family, guardianship graph, per-child access, contact priority | Gibbon family; OpenEduCat `child_ids` portal rule; never Fedena's provisioning |
| Admissions | Applicant → program intake (simple funnel) | Intake campaigns with age/count caps, pipeline states, form builder | Gibbon form engine + staged processors; OpenEduCat caps |
| Fees | Program fee plans, installments (sum-100%), receipts, ledger | Tuition terms, discounts/waivers, arrears, receipts (parents pay) | Lesson from Fedena copy-on-create + OpenEduCat installments |
| Communication | Announcements per section/role; email/SMS outbox | + class/teacher comms, letters home, SMS to guardians | Gibbon messenger targeting + Gibbon notification events |
| Pastoral / extras | Not in core | Behaviour, first aid/medical, SEN/IN, activities + waiting lists, eligibility, transport/hostel (mode-gated) | openSIS eligibility; Gibbon behaviour/IN/activities |
| Reporting | GPA, transcript, enrollment stats, clearance docs | + honor roll/rank, attendance summaries, class lists, letters/ID forms | openSIS GPA pipeline + `$extra` single-definition/many-outputs pattern |
| Dashboard floor | Student: week, balance, holds, docs | Student: attendance ledger, fees, results, timetable; Parent: child switcher | EduPro demo IA: ≤8 nav items, 4–6 widgets |

## Structural rules (must hold in schema)

1. Organisational units (grade levels, homerooms, departments, houses) are rows with a
   `kind` — not separate tables per concept.
2. Placement/promotion is a dated event chain (enrollment + promotion records), never a
   mutable `currentSection` alone; history is queryable.
3. Attendance shape is chosen per school (policy) but stored in the same event model
   (raw events + derived day summaries); mode only changes capture UX defaults.
4. Grading surfaces (scale engine, weighted components, posted snapshot) are shared;
   mode changes permitted component types (HE: coursework/exam weights; K12: CA/test/exam).
5. Guardianship is a first-class relation usable in HE (emergency contacts, consent) —
   K12 just requires it and enables the portal experience.
6. Every K12-only entity references `schoolId` and a mapping date; enabling mode later
   never requires back-migration (fields nullable-safe, gates default off).

## What we deliberately did NOT adopt

- Separate per-mode databases or forks (all four references show the maintenance cost).
- Term/year literals on every row (openSIS) — references to year/term rows only.
- Enterprise-gated multi-campus shapes (OpenEduCat) — our tenancy is core, not add-on.
- K-12 concepts in the HE core schema before Phase 9 (houses, behaviour) — capability
  gates + Phase 9 migrations instead.

Acceptance for Phase 1a: schema expresses dimensions 1–4 and 6 generically (kind rows,
dated placement, shared attendance/grading engines) with HE seeds only; K-12 seeds and
gates land in Phase 9 without breaking HE invariants.
