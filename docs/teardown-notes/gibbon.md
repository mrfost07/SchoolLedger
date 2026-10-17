# Gibbon teardown notes (read-only study, no build/run)

- Repo: github.com/GibbonEdu/core @ `65f86bf` (2026-10-16), **v31.0.00**; PHP 8.1+, MySQL 8, Apache.
- License: **GPL-3.0-only** (LICENSE; README). Copyleft — usable for study/ideas, not for closed-source reuse.
- Architecture: procedural PHP + selective OO (`src/Domain` gateways, `src/Forms`, Twig views, TCPDF/Mpdf). ~200 tables in `gibbon.sql`; settings live in `gibbonSetting` (scoped name/value). Module = folder in `modules/` with per-action PHP files + `*Process.php` handlers. i18n via gettext + `gibbonString` overrides.

## (b) Module/nav inventory

`gibbonModule.category` drives sidebar grouping: **Admin / Learn / People / Pastoral / Assess / Other**.
| Our grouping | Gibbon modules (side nav entry) |
|---|---|
| Academics/curriculum | Planner (units, lesson/homework, homework submission + crowd assess), Departments, Tracking (graphs) |
| Enrollment | Admissions (applicationForm, applications_manage, accept/reject, studentEnrolment_manage, withdraw), Data Updater (family-initiated updates) |
| Student records | Students (profiles, notes, alerts, medical, first aid, IN), User Admin (person/family/role/permissions/rollover) |
| Scheduling | Timetable (view, layers), Timetable Admin (TT, columns, day-row-class, exceptions, bookings, import), Calendar (events) |
| Assessment | Markbook, Formal Assessment (external exam tracking), Rubrics, Reports (report cards: cycles/scopes/criteria → PDF), Individual Needs (SEN), Behaviour |
| Billing | Finance (invoices, billing schedules, fees, budgets, expenses, petty cash, online payments) |
| Communication | Messenger (email/SMS/wall, mailing lists, receipts, canned responses), Notification events, Calendar |
| Reporting | Reports module archives; per-module `report_*` pages (attendance summaries, emergency SMS lists, transport, letters home, ID cards) |
| Admin/config | School Admin (year/terms/special days, year groups, form groups, houses, scales, departments, spaces, file types, external assessments, module settings), System Admin (settings, themes, i18n, hooks, cron, logs), User Admin (roles/permissions), School Reports |

## (c) DB highlights (~15 most important)

1. `gibbonPerson` — single identity/auth table for students, staff, parents; `gibbonRoleIDPrimary` + `gibbonRoleIDAll` (CSV) = multi-role; `status` Full/Expected/Left/Pending Approval; contacts, DPA, MFA/OAuth columns.
2. `gibbonRole` (category Staff/Student/Parent/Other, type Core/Additional, canLoginRole, future/pastYearsLogin, restriction None/Same Role/Admin Only), `gibbonAction` (module action def + URLList + entryURL + default perms per category), `gibbonPermission` (role×action).
3. `gibbonStudentEnrolment` — person×schoolYear → yearGroup + formGroup + rollOrder (per-year placement; supports history).
4. `gibbonCourse` (per schoolYear, department, yearGroup list) / `gibbonCourseClass` (sections; reportable + attendance flags, enrolment min/max, target scale) / `gibbonCourseClassPerson` (role Student/Teacher/Assistant/Parent/-Left with enrolled/unenrolled dates).
5. `gibbonTT*` — cycle-day timetable: `gibbonTT` (year+year groups), `gibbonTTDay` (Day 1..N), `gibbonTTColumn`/`TTColumnRow` (periods with time + type Lesson/Break/…), `gibbonTTDayRowClass` (day×row→class+space), `TTDayDate` (map cycle days→dates), exceptions, space bookings/changes, CSV import.
6. Attendance: `gibbonAttendanceCode` (direction In/Out; scope Onsite/Offsite + Late/Left variants; reportable; prefill; role list), `gibbonAttendanceLogPerson` (event per person; context Form Group/Class/Person/Future/Self Registration), `LogCourseClass`/`LogFormGroup` (session-taken records with taker+timestamp).
7. `gibbonMarkbookColumn` (per class; attainment vs effort; scale; raw max; weighting; rubric; visibility to students/parents; complete) / `MarkbookEntry` (per student: scale value, raw value, descriptors, concern flag, comment, response) / `MarkbookWeight` (per type: weighting, calculate term|year, reportable) / `MarkbookTarget` (personalized targets).
8. `gibbonScale` + `gibbonScaleGrade` — named scales (IB, GCSE, %, letters, completion…) with `lowestAcceptable` + sequence.
9. `gibbonReportingCycle` (dates, milestones) → `ReportingScope` (Year Group/Form Group/Course) → `ReportingCriteria`(+Type: valueType/scale/charLimit/options) → `ReportingValue` (per student/class; grade+comment) + `ReportingProgress`/`ReportingProof`.
10. `gibbonFamily` + `FamilyAdult`/`FamilyChild` (contact priority, child data access, call/SMS/email/mail prefs) + `FamilyRelationship`; adults/children all `gibbonPerson`.
11. `gibbonFinanceInvoice` (+`Invoicee`, `InvoiceFee`, `Fee`, `BillingSchedule`, `Payment` — polymorphic `foreignTable/ID`) — family or company invoicing, scheduled/ad-hoc, reminders, online pay.
12. `gibbonAdmissionsApplication` (status Incomplete/Pending/Waiting List/Accepted/Rejected/Withdrawn; milestones; polymorphic payload) + `gibbonApplicationForm` + generic form engine `gibbonForm`/`FormPage`/`FormField` (conditional JSON, per-audience) / `FormSubmission`/`FormUpload`.
13. `gibbonActivity*` (clubs: categories/types, slots, staff, student choices, backup choice, waiting list, invoice link).
14. Pastoral/support: `gibbonBehaviour` (Positive/Negative/Observation, descriptors, levels, follow-up, letters), `gibbonMedicalCondition`, `gibbonPersonMedical*`, `gibbonFirstAid`(+FollowUp), `gibbonIN*` (SEN descriptors/investigations/assistants/archive), `gibbonStudentNote`+categories, `gibbonAlert`/AlertType/AlertLevel.
15. Cross-cutting: `gibbonCustomField` (context + per-audience flags; values JSON in each entity's `fields` TEXT), `gibbonLog` (audit w/ serialised arrays), `gibbonSession`, `gibbonSetting` (scoped name/value), `gibbonSchoolYear`→`SchoolYearTerm`→`SchoolYearSpecialDay`, `gibbonYearGroup`, `gibbonFormGroup` (incl. `formGroupIDNext` promotion link), `gibbonHouse`, `gibbonSpace`, `gibbonLibraryItem/Event/Shelf/Type`, `gibbonStaff*` (contracts, absences, coverage, substitutes, duties, job openings).

## (d) Roles & permissions

- One login = one `gibbonPerson`; role set on the person (`RoleIDPrimary` + `RoleIDAll` list) → multi-role people; role switcher (`roleSwitcherProcess.php`) for staff with multiple roles; role `restriction` gates who can act as whom.
- Access check per action: `isActionAccessible($guid,$conn,'/modules/X/y.php')` → `gibbonAction` row → `gibbonPermission`. Admin default-permission checkboxes per action (`defaultPermission*`, `categoryPermission*`) seed new roles.
- Role properties: `canLoginRole`, `futureYearsLogin`/`pastYearsLogin` (which school years a role may browse via year switcher).
- Custom fields and most tables are keyed to role categories for visibility.

## (e) School / term / calendar assumptions

- **No school/tenant table** — one install = one school (`organisationName` setting). `gibbonDistrict` is just a contact lookup. Multi-school would need a fork or separate installs.
- Hierarchy: `gibbonSchoolYear` (status Past/Current/Upcoming, first/last day) → `gibbonSchoolYearTerm` (n terms) → `SpecialDay` (closures/timing change/off timetable, per year group or form group, cancels classes/activities/bookings).
- Timetable is **cycle-day based** (Day 1..N mapped to real dates), not weekly; heavy K-12 secondary assumption but adaptable.
- Rollover: new school year, copy form groups, map `formGroupIDNext` for promotion, carry `gibbonStudentEnrolment`; data remains in same tables keyed by `gibbonSchoolYearID`.

## (f) K-12-specific features HE systems lack

- Year groups (grade levels) with Head of Year; form groups/tutor groups with tutors + EAs, attendance per form group.
- Parents modeled as first-class family with siblings, relationship graph, contact priority and per-child data access; parent portal dashboard.
- Attendance codes with direction (In/Out) and scope (Onsite/Offsite/Late/Left-Early) + self-registration kiosk; absence reason/type; future absence logging.
- Behaviour rewards/sanctions with descriptors, levels, letters home; First Aid/medical alerts; Individual Needs (SEN) with descriptors/strategies and archives.
- Admissions funnel w/ public application form, application fee, configurable milestones, offers/waiting list/rejection; per-family enrolment management and withdrawal flow.
- Extracurricular activities (competitive or selection-based, waiting lists, fees invoiced via Finance), houses, library loans, transport reporting by form group, formal/external assessments (public exams), student notes/alerts, letters home, emergency SMS lists.

## (g) Notable workflows worth copying

1. **Markbook model**: one row per class×column; separate attainment and effort; value = scale grade, optional raw mark → auto % → scale lookup; per-type weightings (`calculate='term'|'year'`); visibility flags per column for students/parents; completion flag; rubrics; personalized target per student (`MarkbookTarget`) with "exceeded personal target" flag. Averages computed per page-load from entries+weights.
2. **Attendance taking**: default "prefill" code (Present) then exceptions; log per person with context; separate session-completion rows allow "classes not registered today" reports; attendance blocked on non-school days; gateway classes (`AttendanceLogPersonGateway`) keep SQL out of pages.
3. **Report cards**: cycles/scopes/criteria modeled as data (not code); teachers write per-scope values; proofreading pass (`ReportingProof`); batch PDF generation (Twig templates + TCPDF/Mpdf) stored as files with a DB archive index per student/family/report; delivery to parents; also imports externally produced PDFs into the archive.
4. **Admissions as pipeline**: DB-driven form builder (conditional fields, hidden/prefill, per-audience groups) + staged processors (Check → Submit → Accept), where Accept chain creates family, parents, student, medical, IN and invoice records; polymorphic payment attached to submission; status enum + milestones as workflow state.
5. **Data Updater**: parents edit "shadow update" rows (`gibbonPersonUpdate`, `StaffUpdate`, `MedicalUpdate`, `FamilyUpdate`, `InvoiceeUpdate`) which admins compare/approve — clean maker-checker for identity data.
6. **Role-switching + year-switching** designed into the session/permission model (staff can view as student/parent, browse past/future years where allowed).
7. **Custom fields**: `gibbonCustomField` definitions (type/options/required/audience) + JSON values in a `fields` TEXT column on each entity — schema-stable extensibility used by admissions, data updater and public registration alike.
8. **Notification/event bus**: `gibbonNotificationEvent` + listeners comparing relative dates (e.g., due soon), plus Messenger targets (role/year group/form group/class/mailing list) with receipts; polymorphic `gibbonPayment` reused by finance, activities, admissions.

## (h) Weaknesses / simplifications

- Single-school hard assumption; no tenant dimension anywhere; year switch/rollover is copy-in-place, not bitemporal.
- Permission defaults are permissive (`categoryPermission*` default Y), and permission checks are per-URL-string — easy to drift.
- Finance is invoice-centric; no student account/statement/GL depth (fine for fees, weak for HE bursar needs). Finance/school-year columns repeated per row.
- Markbook averages recomputed per request; no grade-change audit beyond `gibbonLog`; scale comparisons rely on string values + sequence numbers.
- Report cards archived as files (no structured re-render); heavy legacy procedural style with large `$_SESSION`/globals; jQuery-era UI.
- Attendance/behaviour libraries assume secondary-school shapes (form group + cycle days); admissions heavily English-school flavored (houses, year groups, school terms).
