# ADR-0007: Self-hosted packaging — same artifact, setup wizard, licensing posture

- Status: accepted (Phase 0, 2026-10-17)
- Evidence: `docs/teardown-notes/*` licenses (GPL-2/3, LGPL-3 = study only);
  current stack: Fastify + Prisma + Postgres + Redis + BullMQ + S3-or-fs storage

## Context

Two delivery shapes must coexist: (a) vendor SaaS (many schools, platform console,
plans/limits) and (b) self-hosted single-school installs where the school runs our
software on their infrastructure. References show both extremes: standalone PHP
installs (Gibbon/openSIS — no ops tooling) vs platform-bundled (OpenEduCat/Odoo).

## Decision

- **One artifact, one codebase.** Self-hosted = the same container images run with
  `DEPLOYMENT_MODE=single` (one school row, school switcher hidden, RLS pinned to that
  school). No second repo, no fork.
- **Packaging**: Docker images (backend, frontend, worker) + `docker-compose.yml`
  (postgres, redis, minio for S3-compatible storage, the three services); an installer
  script and a **first-run setup wizard** (create School #1 + admin, SMTP, branding,
  timezone/currency, seed policy templates) — wizard is a real product surface, not a
  CLI afterthought.
- **Ops surface**: `/healthz`, `/readyz`, structured logs (pino) already exist; add
  backup/restore scripts (pg_dump + storage sync) and a documented upgrade path
  (`prisma migrate deploy` + image tag). No external SaaS dependency is required for
  core function; SMS/card providers are optional adapters (ADR-0005/0006).
- **Licensing posture**: we studied GPL/LGPL codebases — their licenses do **not**
  propagate into our code (clean-room study of ideas/architecture only; no code,
  schema DDL, assets, or copy-paste). Our own licensing for self-hosted distribution is
  a product decision (candidate: source-available or dual-license); decision deferred
  to Phase 11 but recorded here as unresolved.
- **Feature gates in self-hosted**: SaaS-only surfaces (platform console, plans/limits,
  support-access grants) compile in but stay disabled by mode; nothing forks.

## Consequences

- CI must build the images and run a compose smoke test (CI-only, since local has no
  Docker — see environment notes).
- Mode flag (`DEPLOYMENT_MODE`) interacts with tenancy: single mode seeds exactly one
  school and hides multi-school UI, but the schema stays identical (SaaS migration path
  = flip mode, add schools).
- Upgrade/backup runbooks become Phase 11 deliverables with tested restore drill.

## Alternatives rejected

- Stripped "community edition" fork for self-hosted: divergence cost, the failure mode
  visible in OpenEduCat's Enterprise-gated features.
- Kubernetes-first packaging: compose covers the target audience; k8s manifests later
  if demand appears.
