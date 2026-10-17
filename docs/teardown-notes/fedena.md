# Teardown: Fedena (projectfedena/fedena)

- Repo: https://github.com/projectfedena/fedena, shallow clone at `tools/reference/fedena`
- HEAD: `68a84ac` (2016-07-20, commit msg "emptying content"); code vintage 2011-2013 (Rails 2.x)
- Verified from source only; nothing installed/built.

## (a) License
- Apache-2.0 (`NOTICE` + license header on every .rb file). No copyleft obligations for our product.
- Plugin ecosystem (hostel/transport/library/etc.) is NOT in this repo; only its tables leak into `db/schema.rb`.

## (b) Module / nav inventory (controllers + models)
| Area | Controllers | Notable models |
|---|---|---|
| Academics | courses, batches, subjects, electives, batch_transfers, class_timings, weekday | Course, Batch, Subject, ElectiveGroup |
| Enrollment/admissions | student, archived_student, (applicant flow in student_controller/registrations) | Applicant\*, Registration\*, Guardian |
| Student records | student, archived_student, additional fields | Student, Guardian, ArchivedStudent, StudentAdditionalField |
| Scheduling | timetable, timetable_entries, calendar, event | Timetable, TimetableEntry, PeriodEntry, Event |
| Assessment | exams, exam_groups, exam_scores, grading_levels, exam_reports, cce_\* (categories/settings/grade sets/weightages), fa_groups, fa_criterias, observation_groups/observations, descriptive_indicators, ranking_levels, assessment_tools | ExamGroup, Exam, ExamScore, GradingLevel, GroupedExam(Report), RankingLevel, CceReport, AssessmentScore |
| Attendance | attendances, student_attendance, attendance_reports, employee_attendances | Attendance, SubjectLeave, EmployeeAttendance |
| Billing/finance | finance, payroll | FinanceFeeCategory/Particular/Collection/Fee, FinanceTransaction(+Category/Trigger), FeeDiscount (STI), InstantFee, Donation, EmployeeSalaryStructure, MonthlyPayslip, PayrollCategory |
| HR | employee\*, payroll | Employee, EmployeeDepartment/Position/Grade/Category, EmployeeLeave(+Type), ApplyLeave |
| Communication | news, reminder, sms, sms_settings, event, user (groups) | News(+Comment), Reminder, SmsMessage/Log/Setting, UserEvent, Group(Post) |
| Reporting | attendance_reports, exam_reports, cce_reports, finance | GroupedExamReport, CceReport (+ plugin-era report_queries/columns tables) |
| Admin/config | configuration, user, scheduled_jobs (delayed_job) | Configuration, SchoolDetail, Privilege, User, DelayedJob |
- Plugin-era only (tables exist; no code in repo): hostels/room_allocations, transports/routes/vehicles, books/book_movements, stores/grns/purchase_orders, polls, tasks, online exams/meetings, placements, gallery.

## (c) DB schema highlights (~185 tables; schema.rb stale: v20120525 vs migrations to 2013-01-10)
| Table | Models |
|---|---|
| `users` | login identity; booleans admin/student/employee/parent; hashed_password(SHA1+salt); school_id |
| `students` / `archived_students` | admission_no, class_roll_no, one `batch_id` (current class), immediate_contact_id (guardian), is_active/is_deleted |
| `guardians` / `archived_guardians` | ward_id FK to student; contact info; own user_id for parent login |
| `courses` / `batches` / `batch_students` | course = class (code, section); batch = cohort/section instance (start/end dates, grading_type, class-teacher employee_id); M2M history table batch_students = "graduated" batches |
| `subjects` / `students_subjects` / `elective_groups` | subject belongs to batch; elective_group_id; credit_hours/amount; per-student subject assignment (electives) |
| `exam_groups` / `exams` | group per batch/type with weightage, is_published/result_published, is_final_exam; exam per subject with max/min marks, weightage, event_id |
| `exam_scores` / `archived_exam_scores` / `previous_exam_scores` | one row per student×exam: marks OR grading_level_id, is_failed, remarks (retakes live in previous_exam_scores) |
| `grading_levels` | per-batch (or batch_id NULL = global default) bands: name, min_score only, order, credit_points (GPA), is_deleted |
| `grouped_exams` / `grouped_exam_reports` | cross-exam-group weightage per batch; materialized report rows keyed score_type s=subject/e=exam group/c=cumulative |
| `attendances` / `subject_leaves` | day-level absence row (forenoon/afternoon flags, or period_table_entry_id for subject-wise); subject_leaves = subject absence w/ reason |
| `timetables` / `timetable_entries` / `class_timings` / `weekdays` / `period_entries` | timetable versions by date-range; entries = batch×weekday×timing×subject×employee; break rows; per-batch weekday overrides; per-date period map for substitutions/subject attendance |
| `events` / `batch_events` / `user_events` / `employee_department_events` | one calendar entity: is_common/is_holiday/is_exam/is_due + polymorphic origin (exam/fee collection auto-create events); scoped to batch/user/department |
| `finance_fee_categories` / `finance_fee_particulars` / `fee_discounts` | reusable fee template per batch (is_master); particular targets student_category OR specific student (admission_no/student_id); discounts STI subclasses keyed by receiver (batch/category/student) |
| `finance_fee_collections` / `finance_fees` / `finance_transactions` | collection = dated installment per batch (copies category data on create); fee per student×collection w/ transaction_id CSV list; transactions = ledger (category, receipt/voucher no, fine_amount, master_transaction_id for trigger splits) |
| `employees` + salary/payslip tables | employee dossier; salary structures per payroll category; monthly_payslips with approve/reject state; extra monthly categories |
| `configurations` | global key/value settings (StudentAttendanceType, GPA/CWA/CCE flags, AvailableModules, TimeZone...) + school_id column |
| `schools` / `school_details` | name+code (schools), logo (school_details); school_id denormalized on nearly every table |
| `applicants` / `registrations` | two admission generations: applicant_* tables (online reg with custom fields) and registrations (reg_no, batch, acceptance_status, subject_choice, community_reservation) |
| `privileges` / `privileges_users` | fine-grained permission name tags granted to users (CanCan-style `role_symbols`) |

## (d) Roles & permission model
- 4 fixed roles, stored as booleans on `users` (admin/student/employee/parent) + `role` attr set on create; no roles table.
- RBAC = base role + `privileges` M2M; `User#role_symbols` yields [:admin]/[:student]/[:employee]/[:parent] + privilege names; employee gets implicit `:subject_attendance`/`:subject_exam` if they teach any subject, `:view_results` if a class teacher of an active batch.
- Account provisioning is side-effect of record creation: student create → user (username = admission_no, password = admission_no+"123"); immediate-contact guardian → parent user (username = "p"+admission_no, password "p{admission_no}123"); `Guardian.shift_user` soft-deletes the old parent account when immediate contact changes.
- Deactivation = `is_deleted` soft flags; deleting student archives to `archived_students` + soft-deletes user (records retain history, login dies).

## (e) School / term / calendar hierarchy
- Unit of tenancy = one installation (one school DB). "Multi-school" is only partially scaffolded: `schools` table, `school_id` column on ~everything, per-school logo; but no `School` model in app code and `Configuration.get_config_value` ignores school_id → global config despite the column. Treat as unfinished multi-tenant.
- NO first-class academic year or term entity. Time is carried by Batch start/end dates; reports/attendance derive "academic period" from batch range ∩ weekday config − holiday events.
- Calendar = `events` (common holidays, batch holidays, exam events auto-created, fee due events); working days computed in `Batch#find_working_days`.
- Grading scale hierarchy: Batch → own GradingLevels, else global default GradingLevels (batch_id NULL); `batch.grading_type` = Normal/GPA("1")/CWA("2")/CCE("3") gated by global Configuration flags.
- Timetable hierarchy: Timetable(date range, is_active) → TimetableEntry(batch, weekday, class_timing, subject, teacher); optional per-batch Weekday overrides and break rows in ClassTiming.

## (f) K-12-specific features
- CCE (India K-12): cce_exam_categories, cce_grade_sets/grades, cce_weightages (per course), fa_groups/fa_criterias (formative assessment), observations/observation_groups + descriptive_indicators (co-scholastic grade points), cce_reports generated per batch per exam (scholastic from FA criteria, co-scholastic from observations).
- Report cards: GroupedExamReport aggregation + RankingLevel medal rules (marks/gpa thresholds, subject_count with upper/exact/lower limits, full_course) + class rank and attendance rank.
- Others: elective groups/subsections, batch transfers, community reservations + student categories for admissions, SMS notifications to parents (`is_sms_enabled` per student), student additional custom fields per tenant, library cards.

## (g) Workflow patterns worth copying
1. Exam lifecycle with staged visibility: exam_group.draft → exams entry → is_published (student can see exam) → result_published (student sees results); separate final-exam flag for term aggregation.
2. Weighted aggregation as a denormalized cache: exam.weightage × exam_group.weightage averaged into `grouped_exam_reports` rows with score_type s/e/c, regenerated by a delayed_job (`Batch#perform` with job_type). Fast report cards, at the cost of a rebuild step.
3. Grading levels as tenant/batch data with default fallback (`batch.grading_level_list` → GradingLevel.default) + `percentage_to_grade` via "highest min_score ≤ %"; GPA credit_points are per grade, subject credit_hours weigh totals.
4. Fee template → collection copy-on-create (`FinanceFeeCollection#create_associates` clones particulars/discounts into collection-scoped rows) so mid-year edits never mutate history; particulars target who pays (all / student category / single student) and discounts stack by receiver type with a 100% cap.
5. Explicit money movement pieces: finance_transactions with auto receipt_no/voucher_no sequences, fine_amount/fine_included on the same row, and `FinanceTransactionTrigger` rows that auto-create linked percentage splits (master_transaction_id) — e.g. cut % to a saving scheme on every fee receipt.
6. Attendance modeled as exception rows (absence/half-day/subject leave), not per-student per-day check-ins; Daily vs SubjectWise is a single config switch (`StudentAttendanceType`) reusing period_entries for subject periods; working-day math lives with the batch.
7. One calendar for everything: exams and fee collections auto-create linked Events (polymorphic origin), so student/parent/teacher dashboards query a single events feed with scope flags (is_common/is_holiday/is_exam/is_due).
8. HR leave/payroll approval chains: apply_leaves (approved/viewed_by_manager/manager_remark), monthly_payslips with is_approved/approver and is_rejected/rejector/reason, and payroll categories that can be nested or percentage-based.

## (h) Weaknesses / simplifications
- `db/schema.rb` is stale (misses CCE/assessment tables added by later migrations) — never trust it without migrations.
- No academic-year/term object; cross-year reporting and rollover are manual (batch dates only). Term/semester = batch name convention.
- Grade bands use min_score only (no max); overlapping ranges not validated; grade scale change re-writes history since scores store grading_level_id (archived copies exist but only partially maintained).
- Money: finance_fees.transaction_id is a comma-separated id list (FIND_IN_SET queries), is_paid boolean duplicated with has_paid_fees on students; no ledger accounts/double-entry; receipt numbering via scan/next on last string.
- User/role model: 4 hardcoded boolean roles, no scoping to school/campus; passwords SHA1+salt; accounts hard-deleted/soft-deleted ad hoc (shift_user destroys old parent logins).
- Multi-school columns exist but code ignores them (config lookups unscoped) — do not copy this half-migration pattern.
- Heavy string-interpolated SQL in scopes/controllers (injection hazards, locale/decimal bugs; e.g. BigDecimal→string amounts in salary structures).
- Report generation is synchronous inside fat models during request/job; GroupedExamReport rebuild deletes+recreates all rows per batch.
- Archived_* twins duplicate full tables; events is_due/exam flags conflate domains; plugin-era dead tables (hostel, transport, polls, tasks...) bloat the schema and confuse FK reasoning.
- No API/queue boundary between domains; controllers call models with SQL-ish searchlogic named scopes; validation callbacks ordering quirks (`after_validate`, `before_save` for user creation).
