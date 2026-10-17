# Teardown: OpenEduCat ERP (openeducat/openeducat_erp)

- Repo: https://github.com/openeducat/openeducat_erp, shallow clone at `tools/reference/openeducat`
- HEAD: `46a5d7d` (2026-10-13) — Odoo 19.0 community modules, version 19.0.1.0
- Verified from source only; nothing installed/built. OSS edition vs paid "Enterprise" addons is visible in settings toggles.

## (a) License
- LGPL-3 (repo LICENSE + every `__manifest__.py` `'license': 'LGPL-3'`); module names prefixed `openeducat_`.
- OSS repo = 14 modules. A settings model lists ~100 more (Enterprise): campus, transportation, placement, scholarship, alumni, LMS/quiz/H5P, thesis, convocation, OMR, face-recognition kiosk, discipline, health, notice board, grievance, dashboard KPI...

## (b) Module inventory (module -> depends -> key models)
| Module | Depends | Key models |
|---|---|---|
| `openeducat_core` | board, hr, web, website, contacts | op.student, op.student.course, op.program(+level), op.course, op.batch, op.subject, op.subject.registration, op.department, op.faculty, op.category, op.academic.year, op.academic.term |
| `openeducat_classroom` | core, facility, product | op.classroom, op.asset |
| `openeducat_facility` | core | op.facility, op.facility.line |
| `openeducat_timetable` | classroom | op.session (a scheduled lecture), op.timing |
| `openeducat_attendance` | timetable | op.attendance.register, op.attendance.sheet, op.attendance.line, op.attendance.type |
| `openeducat_exam` | classroom | op.exam.session, op.exam, op.exam.attendees, op.exam.room, op.exam.type, op.grade.configuration, op.result.template, op.marksheet.register/.line, op.result.line (+ wizards held_exam, room_distribution) |
| `openeducat_admission` | core, fees | op.admission.register, op.admission(+fees.line) |
| `openeducat_assignment` | core | grading.assignment(+type), op.assignment, op.assignment.sub.line |
| `openeducat_activity` | core | op.activity, op.activity.type |
| `openeducat_fees` | core, account | op.fees.terms(+line), op.fees.element, op.student.fees.details |
| `openeducat_library` | core (+partner) | op.library.card(+type), op.media(+type/unit/queue/movement/purchase), op.author, op.publisher, op.tag |
| `openeducat_parent` | core | op.parent, op.parent.relationship |
| `openeducat_erp` | admission+assignment+attendance+library+parent+exam | (meta-bundle app; no models) |
| `theme_web_openeducat` | website | theme assets |

## (c) Key models (~18)
| Model | Notes |
|---|---|
| `op.student` | `_inherits` res.partner (student = partner + fields); unique gr_no, user_id portal login, category, course_detail_ids; copy() blocked |
| `op.student.course` | THE enrollment line: student×course×batch×roll_number (+academic year/term, subject_ids M2M, fees_term/product via other modules, state running/finished); unique(roll,course,batch), unique(student,course,batch) |
| `op.program` / `op.program.level` | degree program + level (K-12 grade / UG / PG); program has min/max unit load |
| `op.course` | subject bundle under a program; parent_id hierarchy; `evaluation_type` normal/GPA/CWA/CCE (Fedena heritage); department |
| `op.batch` | section/cohort of a course w/ start/end dates (no academic-year FK — dates carry it) |
| `op.subject` | code unique; theory/practical/both; compulsory/elective; grade_weightage; department |
| `op.subject.registration` | per-student unit-load registration: compulsory/elective subjects, min/max unit load, workflow draft→submitted→approved/rejected; approve copies subjects into the enrollment line |
| `op.academic.year` | term_structure generator (two_sem, two_sem_qua, two_sem_final, three_sem, four_Quarter, final_year, others); company_id |
| `op.academic.term` | term rows with parent_term (nested quarters/final), unique name/dates per year; company_id |
| `op.department` | HE-style department tree (parent_id); user dept_id + allowed department_ids |
| `op.faculty` | `_inherits` res.partner; faculty_subject_ids M2M; emp_id→hr.employee (create_employee bridges user/partner); main/allowed departments |
| `op.exam.session` | exam campaign: course+batch+type+dates+venue, evaluation normal/grade, state draft/schedule/held/cancel/done |
| `op.exam` | per-subject exam under a session: total/passing marks, time window, state draft/schedule/held/result_updated/done; overlap check per subject; attendees lines |
| `op.exam.attendees` | student×exam row: present/absent, Integer marks (0..total enforced), room |
| `op.grade.configuration` + `op.result.template` + `op.marksheet.register/.line` + `op.result.line` | grade bands (min/max %, overlap-validated) attached to a result template; generate_result() materializes marksheets (draft→validated) with pass/fail counts |
| `op.attendance.register` / `.sheet` / `.line` | register = course+batch(+subject); sheet = date+session+faculty (unique per register/session/date, states draft/start/done/cancel); line = student + present/excused/absent/late booleans or attendance_type preset |
| `op.session` (timetable) | lecture = timing+course+faculty+batch+subject+classroom; days computed; conflicts checked if ir.config_parameter toggles on; student_ids auto-filled from enrollment; followers auto-subscribe; state draft/confirm/done/cancel |
| `op.fees.terms` / `.line` / `op.fees.element` / `op.student.fees.details` | course fee plan → installments (fixed days or fixed dates) that must sum to 100% → elements split each installment across products; per-student fee detail rows (due date, amount, discount %) → account.move invoice |
| `op.admission.register` / `op.admission` | intake campaign (per course or program, fees lines per course, min age, max_count, company) → application w/ state draft→submit→confirm→admission→done/reject/cancel; enroll creates student+enrollment+fee installments+subject registration |
| `op.parent` | parent partner + relationship + student_ids M2M; wires res.users child_ids for portal visibility |

## (d) Roles & permission model
- Odoo groups: per-module "User"/"Manager" privileges (`res.groups.privilege`); core = `group_op_faculty` (implies base.group_user) and `group_op_back_office_admin` (implies base.group_system + partner manager).
- Portal identities: `res.partner.is_student` / `is_parent` flags; student portal user = base.group_portal (created via `create_student_user` or admission settings `enable_create_student_user`); parent user via template + `child_ids` M2M (parent sees children's records).
- Record rules: own-row for students (`user_id = user.id`), child rows for parents (`student_id.user_id in user.child_ids`), faculty rules see all; marksheet/result lines restricted per student/parent.
- Parents are read-only on subject registration except `is_read`/`is_read_by_parent` flags; parent creation refuses when user has child_ids logic inverted (guard blocks parent-created registrations).
- Teachers/faculty can be users; faculty emp_id links to HR (Odoo hr.employee) for Time Off etc.

## (e) School / term / calendar hierarchy & multi-company
- Structure: program → course → batch; subject is shared M2M on course and on enrollment lines; academic year → (nested) terms; batch carries its own dates (no AY FK).
- Multi-company = Odoo `res.company` (+ child companies). Only ~12 models actually carry `company_id`: op.academic.year/term, op.subject.registration, op.category, fee terms & fee details, admission register/admission, timetable op.session, attendance type, assignment sub line, library media movement. Entities like op.student/op.course/op.batch/op.subject/op.exam are NOT company-scoped (student gets res.partner.company_id only via partner inheritance).
- Global ir.rules exist for only academic_year, academic_term, subject_registration, category with the standard domain: company_id false OR child_of user.company_id OR in user.company_ids.
- No campus model in OSS; `module_openeducat_campus_enterprise` is a paid toggle — multi-campus/tenant is an Enterprise feature and Odoo users/companies remain the fallback.
- Calendar/times: op.session start/end datetimes drive calendar views; attendance sheets bind to sessions or dates; terms provide date anchors for fees/exam sessions.

## (f) K-12-specific features
- Route: course.evaluation_type CCE (inherited concept) + grade bands (op.grade.configuration, integer percentages) + result templates/marksheets; exam session has normal vs grade evaluation.
- Attendance presets include late/excused (K-12 register style); parent portal module; activity module (op.activity w/ types); discipline/health/achievement etc. are Enterprise.
- K-12 "shape" is thin vs Fedena: no FA/co-scholastic indicators, no report-card templates in OSS; program.level + term structure (final year grades) are the main structural hooks. HE-first bias: unit load/min-max, departments, exam rooms/seating, thesis/convocation/placement are Enterprise.

## (g) Workflow patterns worth copying
1. Admission → enrollment cascade in one transaction: enroll_student() creates op.student (+optional portal user), enrollment line, per-installment fee details with computed due dates (fixed days from fees_start_date or fixed dates), and a subject registration seeded with compulsory subjects; count cap + min-age + application-window validated at register level.
2. Fees as installments of a course plan: op.fees.terms lines must sum to exactly 100%; each student fee detail = amount × value% with own discount; get_invoice() splits into invoice lines per op.fees.element mapping to products, leaving taxes/payment terms/currency to account.move (native Odoo accounting, no homegrown ledger).
3. Exam pipeline with explicit gates: session scheduled only when... exam times must sit inside session dates; per-subject overlaps blocked; marks range enforced; result template refuses until ALL exams are 'done'; grade bands can't overlap; generate_result() creates a marksheet register (draft→validated) with pass/fail counts — a clean "config → capture → emit document → validate" chain.
4. Subject registration with unit-load governance: min/max unit load from course; compulsory vs elective; approval copies the final subject list onto the enrollment line — single writable source of truth per student-term.
5. Attendance as sheet documents: register (who) → sheet (when/who marked) → lines (booleans or named attendance_type presets); sheet state machine (draft/start/done/cancel) + unique constraints; subject-wise vs generic day mode via a config parameter (same switch as Fedena).
6. Timetable conflict detection driven by settings: ir.config_parameter toggles enable faculty / classroom / batch / batch+subject overlap checks (sudo search to see everyone), sessions span midnight-safe overlap math, back-to-back allowed.
7. Mail built-in everywhere: mail.thread + mail.activity.mixin on most models; op.session auto-subscribes faculty+students as followers, prunes unsubscribed on roster change, posts chatter audit of student add/remove, and emails followers once per session on meaningful writes.
8. Parent/child portal linkage: res.users.child_ids M2M rewired whenever parent or student links change, enabling one domain rule style (`student.user_id in user.child_ids`) for every child-visible model (marksheets, results, registration).

## (h) Weaknesses / simplifications
- Multi-company is partial: only 12 models company-scoped; courses/batches/students/exams leak across companies; no campus entity in OSS.
- op.admission.create_invoice() still uses long-dead `account.invoice` API (Odoo 13-era) while fees module correctly uses account.move — dead code/tech debt; enroll path is the real one.
- Academic year ↔ batch/enrollment linkage is loose: batch has only dates; enrollment stores academic_years_id/academic_term_id but exam sessions, attendance and fees don't carry term/company consistently.
- Term generator duplicates long if/elif blocks per structure; 'others' structure has no implementation; two_sem_qua/two_sem_final create sub-quarters inside a loop over academic_term_ids that can mis-target earlier terms.
- Marks are Integer on attendees/result lines (no decimals, no per-question/component marks, no weightage across exams — Fedena's grouped weightage has no equivalent in OSS).
- Faculty model has copy-pasted duplicate `_check_email_unique`; op.classroom mixes direct course_id/batch_id FKs with the session model (two owners of room/schedule semantics); op.student.copy() blocked (good) but no enrollment-transfer history beyond state running/finished.
- Security rules for "student login" are attached to the back-office admin group names in core (mislabeled groups) — risky to copy; per-group ACL via CSV + Odoo defaults otherwise.
- Reporting is basic (marksheet register, attendance xlsx is Enterprise); nothing like batch report-card generation in OSS; library/fees fine details (fines, partial payment plans) are Enterprise (fees_plan) or absent.
