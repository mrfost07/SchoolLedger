# openSIS-Classic teardown notes (read-only study, no build/run)

- Repo: github.com/OS4ED/openSIS-Classic @ `5d546f2` (2026-10-05), **Community Edition 9.3**; PHP 8.x, MySQL 5.7/8, Apache.
- License: **GPL-2.0** (file headers + `License.txt`); docs GPL too. Copyleft.
- Architecture: procedural PHP. Single entry `index.php`/`Modules.php`; bootstrap `Warehouse.php`; all features are pages under `modules/<area>/*.php` addressed as `modname=grades/Grades.php`. Shared libraries in `functions/` (GetStuList, Search, ListOutput, DrawHeader/BC, Widgets, Authorization). Nav = `modules/<area>/Menu.php` arrays keyed per role (`admin`/`teacher`/`parent`/plus `$exceptions`) + `Side.php`/`SideForStudent.php`. Install SQL: `install/OpensisSchemaMysqlInc.sql` (base) + `OpensisUpdateSchemaMysql.sql` (current additions; duplicate table defs — the Update file wins). Stored procs/triggers provided (`*Procs*.sql`, `*Trigger*.sql`).

## (b) Module/nav inventory

Top-level nav areas (from `constants`/Menu files): **students, users(Staff), scheduling, grades, attendance, eligibility, messaging, tools, schoolsetup, miscellaneous**.
| Our grouping | openSIS areas/pages |
|---|---|
| Academics | schoolsetup CourseCatalog/Courses/Sections/Periods/MarkingPeriods/Calendar; students GoalReport (`goal`,`progress` tables) |
| Enrollment | students Student (profile incl. enrollment), StudentReenroll, EnrollmentCodes, Upload; tools DataImport; schoolsetup Rollover |
| Student records | students Student (demographics, contacts/addresses, medical, enrollment), PeopleFields/StudentFields (custom fields), StudentFilters, Letters, MailingLabels; users Staff/User |
| Scheduling | scheduling Schedule/Requests/MassSchedule/MassRequests/MassDrops/Scheduler (auto), AddDrop, UnfilledRequests, IncompleteSchedules, Print* |
| Assessment | grades Grades (gradebook), Assignments, Configuration, EditReportCardGrades, ProgressReports, ReportCards (FDF fillable PDF), FinalGrades/InputFinalGrades, Transcripts, GPA (CalcGPA/FixGPA), GPARankList, HonorRoll, AnomalousGrades |
| Billing | **none** (no fee/invoice/payment/cashier tables in either schema file; `schoolsetup/SetCurrency.php` only stores a currency choice in `program_config`) |
| Communication | messaging Compose/Inbox/SentMail/Trash/Group (internal mail only), schoolsetup PortalNotes, login_message; outbound `mail()` is used only for admin hacking/DB-error/forgot-password notices |
| Reporting | tools Reports, students AdvancedReport/EnrollmentReport/GoalReport, users UserAdvancedReport, tools DataDictionary/Export/UserExport, print views everywhere; each report is a query fragment (`$extra`) |
| Admin/config | schoolsetup Schools, SchoolCustomFields, SystemPreference, CopySchool; users Profiles (user_profiles + profile_exceptions), AddStudents/AddUsers; tools Backup/Rollover/DeleteLog/GenerateApi/LogDetails |

## (c) DB highlights (~15 most important)

1. `schools` — real multi-school table (title/address/principal/phone/reporting_gp_scale, plus legacy `syear`); users switch school in session (`UserSchool()`).
2. `school_years` → `school_semesters` → `school_quarters` → `school_progress_periods` — nested marking periods, each a row with its own `marking_period_id`, `sort_order`, `does_grades`/`does_exam`/`does_comments` flags **and `post_start_date`/`post_end_date` (grade posting window)**; `history_marking_periods` archives MP names for old data.
3. `attendance_calendar` — per date: `minutes` instructional minutes, `block`, `calendar_id`; `school_calendars` (multiple calendars per school); `calendar_events`.
4. `school_periods` — bell periods (title, length minutes, block, attendance flag, start/end time). `courses` (subject+grade_level, per syear/school) and `course_periods` = **section** (course, period, teacher + secondary_teacher, room, days bitmap, mp override, total_seats/filled_seats, does_attendance/honor_roll/class_rank, gender/house restriction, half_day, calendar, weight, credits, grade_scale_id, parent_id for linked sections) + `course_period_var` variants.
5. `schedule` — student×section membership with `start_date`/`end_date`, `dropped` flag, scheduler_lock (drop preserves history vs delete); `schedule_requests` — course requests with `priority`, `with_teacher_id`/`not_teacher_id`, `with_period_id`/`not_period_id` feeding the auto-scheduler.
6. `students` — student user (username/password in-row, demographics, ethnicity/language FKs, estimated_grad_date); `staff` — **all adult users incl. parents** (profile='admin'|'teacher'|'parent' as text + `profile_id` → `user_profiles`); `students_join_users` = parent↔student access mapping (poorly named: student_id, staff_id).
7. `students_join_people` (+`people` name-only table) — contacts/guardians per student: custody, emergency, relation, plus **addn_bus_* fields**; `students_join_address` — address roles (primary residence, mailing, bus flag/pickup/dropoff/no); `student_address`, `student_medical`(+alerts/visits/notes), `student_immunization`.
8. `user_profiles` (id, profile string) + `profile_exceptions` (`profile_id`,`modname`='grades/Grades.php' or 'students/Student.php&category_id=1', `can_use`, `can_edit`) — page-level RBAC rows.
9. `gradebook_assignments` (staff_id, course_period_id, assignment_type_id, points, due date, description, `ungraded`) + `gradebook_assignment_types` (title, **final_grade_percent** weight) + `gradebook_grades` (student, course_period, assignment, points, comment); `grades_completed` = teacher posted a marking period for a period (completion tracking).
10. `report_card_grades` — grade scale entries (title, sort_order, `gpa_value`, `unweighted_gp`, `break_off` threshold, comment, grade_scale_id); `report_card_grade_scales` groups them.
11. `student_report_card_grades` — **posted** grade snapshot per student×course_period×marking_period: grade_percent, grade_letter, `weighted_gp`/`unweighted_gp`/`gp_scale`, `credit_attempted`/`credit_earned`, course_code/title snapshot (transcript source of truth).
12. `student_gpa_calculated` (gpa/weighted_gpa/unweighted_gpa/class_rank/cgpa per MP) + `student_mp_stats` (running cumulative factors, mp_rank, class_size) + `honor_roll` — computed/ranked GPA pipeline.
13. `attendance_day` — daily per student: `minutes_present`, `state_value` (1.0/0.5/0.0), comment; `attendance_period` — per student×date×period: attendance_code, teacher_code, reason, admin override flag, course_period; `attendance_codes` (type teacher/admin, **state_code** P/A/H for state reporting, default_code, source table); `attendance_completed` (staff, period, course_period, substitute fields).
14. `eligibility` (+`eligibility_activities`, `student_eligibility_activities`) — **extracurricular eligibility** checks per student/date/period with entry-time windows (K-12 athletic eligibility); `system_preference` (per school: full_day_minute/half_day_minute).
15. Config/extension: `program_config` (per school+syear key-value feature switches), `program_user_config` (per-user prefs + column views + saved field sets), `custom_fields` + `student_fields`/`staff_fields`/`people_fields` + `*_field_categories` (EAV custom fields per entity), `mail_group`/`mail_groupmembers`/`msg_inbox`/`msg_outbox`, `api_info` (generated API tokens/specs), `hacking_log`, `login_records`.

## (d) Roles & permission model

- Four hard-coded profiles: `admin`, `teacher`, `student`, `parent` (user_profiles rows; profile ids 3=student, 4=parent **hard-coded in PHP**, e.g. `AllowEdit()`).
- `profile_exceptions` grants per-page `can_use`/`can_edit`; `AllowUse()`/`AllowEdit()` read them (cached in `$_openSIS`) but also contain large hard-coded per-role allow-lists (teachers always get TakeAttendance/Grades/Assignments, etc.).
- Menu visibility is role-keyed in each `Menu.php`; `$exceptions[module]` adds page+edit exceptions (e.g. admin Oversight of a teacher-only page).
- Students authenticate via `students.username/password`; parents/teachers/admins via `staff`; parents' access to children via `students_join_users`.
- Grade posting windows enforced in `AllowEdit()` using the selected marking period's `post_start_date`/`post_end_date` (InputFinalGrades returns false outside the window).

## (e) School / term / calendar assumptions

- Genuine **multi-school**: `schools` + `school_id` on nearly every operational table; users pick school; `CopySchool.php` clones setup from another school; `history_school` tracks a student's school history; staff may have `staff_school_relationship`.
- Genuine **multi-year**: `syear` (e.g. 2025) is a literal column on almost every table; nothing is bitemporal. Rollover (`schoolsetup/Rollover.php`) *deletes* next-year rows then copies periods/calendars/marking periods/courses/sections with `rollover_id` lineage; enrollment codes of type `Roll` mark carry-over.
- MP string conventions everywhere: `FY`/`SEM`/`QTR`/`PRO` prefixes, exam MPs prefixed `E`; `GetMP()`, `GetCurrentMP()`, `GetAllMP()` walk the hierarchy. Attendance/report cards/grades join against `marking_period_id`.
- Calendars: multiple named calendars; `attendance_calendar` holds minutes per date; teaching days/non-days drive attendance totals and scheduler.

## (f) K-12-specific features HE systems lack

- Extracurricular eligibility module (activity rosters, entry times, eligibility codes; absence/tardiness rules feed eligibility).
- Honor roll + class rank + weighted GPA + progress reports + report card comments (per MP, per student, per staff) — US transcript culture.
- Bus fields at contact and address level; homeroom flag on staff (teacher homeroom); lunch_period table; grade levels with sections.
- Daily attendance with state reporting codes (P/A/H) and complete/partial-day math (minutes-based state_value vs full/half-day thresholds).
- Parent/student portals as built-in peer experiences (profile-driven menus), report cards/transcripts viewable by parents.
- Student goals/IEP-ish `student_goal`/`student_goal_progress`; student medical alerts/immunizations/visits.

## (g) Notable workflows worth copying

1. **`$extra` query-builder pattern**: pages build `SELECT/FROM/WHERE/ORDER/group/functions` arrays; `Search()`/`GetStuList()`/`ListOutput()` render browse/search/print/export/PDF/labels/letters from the same fragment → one report definition, many outputs.
2. **Grade posting windows** as data (`post_start_date`/`post_end_date` per marking period) enforced centrally in `AllowEdit()` + `InputFinalGrades` — no ad-hoc lock flags.
3. **Completion tracking**: `attendance_completed` and `grades_completed` + `MissingAttendance`/`TeacherCompletion` admin dashboards to chase teachers who haven't posted.
4. **Daily attendance derivation**: `UpdateAttendanceDaily()` aggregates period attendance minutes by state code (P=full, H=half), compares to `system_preference.full_day_minute/half_day_minute`, stores `state_value` 1.0/0.5/0.0 — partial-day attendance as arithmetic, with `FixDailyAttendance`/`DuplicateAttendance` utilities.
5. **Auto-scheduler + requests**: students/parents submit `schedule_requests` (priority, with/not teacher & period); `Scheduler.php` runs with **test mode** (fills unscheduled requests for a date without committing) and delete mode; manual `MassSchedule` for exceptions; `UnfilledRequests`/`IncompleteSchedules` reports close the loop.
6. **Explicit rollover with lineage**: copy-forward of config into `syear+1` with `rollover_id` links; history tables (`history_marking_periods`, `history_school`) preserve names for old records.
7. **Fillable-PDF report cards**: `FDFReportCards.php` string-replaces field names in a pre-built `assets/report_card.pdf` form (per MP courses/grades/comments + YTD/MP absence counts computed in SQL) — print-perfect K-12 report cards with zero PDF layout code.
8. **Computed GPA/rank pipeline**: `CalcGPA`/`FixGPA` jobs write `student_gpa_calculated` + `student_mp_stats` (running sums/counts, ranks, class size); configurable "widgets" (course/GPA/class rank/letter grade) toggle which columns appear across lists/reports.

## (h) Weaknesses / simplifications

- `syear`/`school_id` duplicated on every row and baked into rollover copies — no temporal integrity; "delete then reinsert" rollover is risky.
- Profiles are strings + hard-coded IDs (3/4/5) inside PHP conditionals; ACL lives half in DB (`profile_exceptions`) and half in code (`AllowUse`/`AllowEdit` if/else chains), with modname strings that include `&category_id=`.
- No billing/fees/payments at all; auto-scheduling is greedy request-filling (honors with/not teacher & period preferences but no room-balancing/constraint solver visible); `course_periods` limited to teacher + secondary_teacher.
- Legacy stack: bundled FCKeditor, jQuery/Bootstrap3-era UI, random cache-busting query strings, SQL string-building wrappers (`SqlSecurityFnc`) — security depends on discipline.
- Student and adult identities in different tables (`students` vs `staff`) → cannot unify authentication; parents live in `staff` with `profile='parent'` (hack); contacts in `people` are name-only.
- Attendance uses PHP-side minute math + stored `state_value`; duplicate/recalc utilities exist because the model can drift; grading has no audit trail beyond logs; API is a generator over pages (`GenerateApi`/`api_info`) rather than an API-first design.
