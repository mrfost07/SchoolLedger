# ADR-0001: Multi-tenancy — shared schema, `schoolId` everywhere, Postgres RLS

- Status: accepted (Phase 0, 2026-10-17)
- Deciders: product owner + engineering
- Evidence: `docs/teardown-notes/fedena.md` (half-migrated `school_id`), `openeducat.md`
  (company_id on 12/N models), `opensis.md` (multi-school columns everywhere, no RLS)

## Context

We must serve (a) many schools per deployment (SaaS) and (b) single-school self-hosted
installs, with the same codebase. The current schema is single-tenant (25 models, no
tenant column). References show the failure modes of partial tenancy: columns on some
models (OpenEduCat), columns everywhere but scope-aware only by convention (Fedena,
openSIS), or separate installs (Gibbon).

## Decision

- Shared database, shared schema. Every operational table carries `schoolId` (FK to
  `School`), including join tables.
- Postgres **RLS with `ENABLE` + `FORCE`** on all tenant tables; policies compare
  `schoolId` to a session variable (`app.current_school_id`) set by the request context;
  Prisma is accessed through a tenant-aware extension so every query is scoped even if
  a developer forgets a `where`.
- Tenant resolution: from the authenticated session (membership) or subdomain/host for
  the SaaS edge; self-hosted deployments run in single-tenant mode where the mode host
  pins the one school.
- Cross-tenant reads/writes are only possible via a platform-admin role with explicit,
  audited "support access" grants (Phase 6), never by ambient query paths.
- A cross-tenant IDOR integration suite is a blocking CI gate from Phase 1a onward.

## Consequences

- One migration path for both deployment shapes; no schema forks.
- RLS becomes load-bearing: local dev/test must exercise the same policies (embedded PG
  supports it), and raw SQL escape hatches need review.
- Join tables and unique constraints gain `schoolId` (e.g. student numbers unique per
  school, not globally — mirrors openSIS lesson).

## Alternatives rejected

- **Database-per-tenant**: strong isolation but multiplies ops/migration cost; conflicts
  with self-hosted simplicity.
- **Schema-per-tenant**: middle ground, still migration fan-out; RLS is simpler.
- **Convention-only scoping (no RLS)**: exactly the failure mode the references show.
