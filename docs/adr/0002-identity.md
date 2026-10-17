# ADR-0002: Identity — one user account, per-school memberships, roles as data

- Status: accepted (Phase 0, 2026-10-17)
- Evidence: `gibbon.md` (single `gibbonPerson`, role switcher), `opensis.md`
  (students/staff split, parents hidden in staff, hardcoded profile IDs 3/4),
  `fedena.md` (boolean role columns, predictable parent passwords)

## Context

Today's backend has `User` with a single role (`STUDENT|ADMIN|REGISTRAR|CHAIR|INSTRUCTOR|
CASHIER`). The target product needs: a person who is a teacher in one school and a
parent in the same or another school; students without email until a later age; parents
linked to multiple children; staff with multiple roles under one login. The references
repeatedly fail at exactly this boundary.

## Decision

- **One identity table** (`User`) for authentication (email/studentNo + credentials +
  MFA), global, never duplicated per role.
- **Membership** (`Membership`: userId × schoolId × status) links a person to each
  school. Roles are **assignment rows** (`RoleAssignment`: membership × role code ×
  scope) — a data-driven registry per ADR-0004's permission model; no role booleans, no
  hardcoded IDs, no separate student/staff auth tables.
- Role codes are seeded per mode (`STUDENT, INSTRUCTOR, CHAIR, REGISTRAR, CASHIER,
  SCHOOL_ADMIN` HE; `STUDENT, GUARDIAN, TEACHER, HOMEROOM_TEACHER, PRINCIPAL, ...` K12).
- **Role switcher**: sessions carry one active membership+role; `view-as` (staff only)
  is an audited session grant, not a credential change.
- **Guardianship** is a relation between two users' memberships (`GuardianLink`:
  guardianMembership × studentMembership × custody/priority/access flags), powering the
  parent portal domain rules (`student ∈ guardian.linkedStudents`), per OpenEduCat.
- Provisioning: invitation or admin-created with one-time credentials; never derived
  passwords (explicitly rejected from Fedena). Student accounts can be `studentNo`-based
  with school-scoped uniqueness.
- Sessions/refresh/MFA contracts stay exactly as they are today (opaque `sp_rt` cookie,
  rotation + reuse detection, step-up `mfaAt` claim) — identity tables change under the
  hood, not the session protocol.

## Consequences

- Existing single-role code paths migrate: `User.role` → active membership's assignment;
  seeds create School #1 with current fixtures unchanged for regression.
- Authorization checks move from `role === 'X'` to permission registry lookups (ADR-0004).
- Cross-school people (teacher+parent) become first-class without new tables later.

## Alternatives rejected

- Per-mode identity systems (K12 parent accounts separate): guarantees rework.
- Email-only identity: locks out young students; studentNo login stays.
