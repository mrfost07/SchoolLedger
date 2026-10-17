# StudentsPortal Backend

Headless Student Information & Academic Management System (SIS). Owns the full academic lifecycle:
students enroll under strict capacity limits, instructors submit grades to an append-only ledger,
standing/honors are computed deterministically, and the registrar issues cryptographically signed
PDF documents that third parties can verify without an account.

No UI ships with this repository — the contract is the OpenAPI 3.1 document produced by
`npm run openapi` (see `openapi.json`).

## Stack

| Concern | Choice |
| --- | --- |
| HTTP | Fastify 5 + `@fastify/type-provider-typebox` (runtime-validated schemas) |
| Contract | `@fastify/swagger` → OpenAPI 3.1 (`openapi.json`) |
| Database | PostgreSQL 14+ via Prisma 6, hardened with raw SQL (`btree_gist` EXCLUDE, CHECK, triggers) |
| Cache / queues | Redis (ioredis) + BullMQ; graceful inline fallback when Redis is absent |
| Auth | Custom HS256 JWT (access + MFA-scoped), rotating refresh tokens, TOTP step-up |
| Crypto | argon2id passwords, HMAC-SHA256 document signatures, SHA-256 serial hashes |
| Documents | `pdf-lib` renderer, QR codes, S3 presigned URLs (or local signed URLs) |
| Money / grades | `decimal.js` (ROUND_HALF_UP, GWA to 4 dp) |

## Requirements

- Node.js >= 22
- PostgreSQL 14+ with the `btree_gist` extension available (migrations run `CREATE EXTENSION`;
  the role needs superuser or the extension pre-installed)
- Redis (production). In development/tests it is optional — set `REDIS_REQUIRED=false`, capacity
  enforcement falls back to the database path and jobs run inline
- S3-compatible object store (optional; `STORAGE_DRIVER=fs` is the default for dev)

## Quickstart

```bash
cp .env.example .env          # then change every secret
npm install
npm run prisma:generate
npm run prisma:deploy         # applies prisma/migrations (incl. hardening SQL)
npm run seed                  # demo catalog: programs, courses, term, sections, users
npm run dev                   # starts API + workers on :3000
```

Poke it: `GET /healthz` (liveness) and `GET /readyz` (DB round-trip + Redis presence).

### Environment

Everything is driven by env vars; `.env.example` is authoritative. The only strictly required
values are `DATABASE_URL`, `JWT_ACCESS_SECRET` and `DOCUMENT_HMAC_SECRET` — all academic policy
thresholds (passing grade, INC window, Dean's Lister and honors cutoffs, unit cap), token TTLs,
storage driver, and rate limits have defaults that mirror `RECONSTRUCTION_LEDGER.md §4`.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch-mode API + workers |
| `npm run build` / `npm start` | Compile to `dist/` / run the compiled server |
| `npm run typecheck` | `tsc --noEmit` over source, scripts and tests |
| `npm run seed` | Idempotent demo data (`prisma/seed.ts`) |
| `npm run openapi` | Regenerate `openapi.json` from route schemas (no DB needed) |
| `npm test` | Full unit + integration suite (see below) |
| `npm run test:unit` | Pure-logic tests (~1 s, no infrastructure) |
| `npm run test:integration` | End-to-end HTTP tests against real Postgres/Redis |

## Tests

The suite needs **no Docker and no services running**: `tests/helpers/infra.ts` boots an embedded
PostgreSQL 18 (`embedded-postgres`) and an in-memory Redis (`redis-memory-server`), applies
migrations and tears everything down. First boot is slow (initdb + migrations); subsequent files
in the same run reuse the instance. Set `TEST_INFRA_DEBUG=1` for step-by-step infra logs.

- **Unit** (`tests/unit`): DAG topological order, schedule-overlap math, GWA/standing/honors,
  grade state machine, canonical JSON / HMAC / JWT primitives.
- **Integration** (`tests/integration`):
  - `iam-auth.spec.ts` — login, refresh rotation + reuse detection (family revocation), logout,
    TOTP enrollment and step-up gates.
  - `enrollment-race.spec.ts` — **50 concurrent reservations against a 5-seat section end with
    exactly 5 enrollments** (Redis Lua gate + ordered row locks + DB CHECK as the last line of
    defense), same-student duplicate storms, direct oversell attempts.
  - `enrollment-flow.spec.ts` — eligibility, idempotent reservation, fees assessment, holds,
    add/drop windows, overload override denial, FIFO waitlist promotion.
  - `grading-flow.spec.ts` — full grade lifecycle with MFA gates, POSTED immutability trigger,
    hash-chain recomputation, GWA/standing/honors endpoints, rectification v2 supersede.
  - `inc-lifecycle.spec.ts` — INC deadlines, completion chains, expiry sweep converts to 5.00
    under a SYSTEM actor, GWA impact.
  - `documents-flow.spec.ts` — snapshot freeze, HMAC signature + serial hash, inline render,
    presigned download with audit, tampered/expired URL rejection, public blind verification,
    registrar-only TOR, revocation, retry of failed renders.

## Domain model

Modules under `src/modules`:

| Module | Responsibility |
| --- | --- |
| `iam` | users, roles, holds, sessions, passwords, TOTP |
| `academics` | departments, programs, curricula, courses + prerequisite DAG, terms, rooms, sections, schedules |
| `enrollment` | eligibility, capacity reservation, fees assessment, waitlists |
| `grading` | grade sheets, state machine, immutable ledger, GWA/standing/honors, rectification, INC lifecycle |
| `documents` | request → snapshot → render → sign → presign → verify → revoke/retry |
| `audit` | append-only hash-chained audit log |

Key invariants (full list with evidence mapping in `RECONSTRUCTION_LEDGER.md`):

- **INV-1** section capacity can never be exceeded, under any concurrency (Lua gate, ordered
  `SELECT ... FOR UPDATE`, `enrolledCount <= maxCapacity` CHECK, guarded `updateMany`).
- **INV-2** no room or instructor double-booking (`EXCLUDE USING gist` on terms).
- **INV-3** prerequisite graph stays acyclic (DAG service + DB guard on edge writes).
- **INV-4** at most one active grade entry per (student, course, term) — partial unique index.
- **INV-5** POSTED grade entries are immutable: changes only via supersede/rectification, enforced
  by a Postgres trigger (`/immutable/`, `/append-only/`).
- **INV-6** audit entries form a verifiable SHA-256 hash chain with per-aggregate sequencing.
- **INV-7** a student's schedule never overlaps (Redis Lua check + GiST backstop at the section level).

Document issuance is deliberately paranoid: what you request is a frozen JSON snapshot, hashed and
HMAC-signed at request time; the rendered PDF embeds a QR pointing at
`/api/v1/public/verify/{serialHash}` which reveals only `valid`, `studentName` and a masked
student number. Download URLs are presigned, single-TTL, tamper-evident and every access is audited.

## API conventions

- **Auth**: `Authorization: Bearer <access token>`. Sensitive operations (grade posting,
  rectification, document revocation) additionally require a recent TOTP step-up (`mfa` claim).
- **Idempotency**: mutating endpoints that move money/units (`POST /enrollments` reservations,
  `POST /documents/requests`) require an `Idempotency-Key` header; replays return the original
  response, mismatched payloads return `409`.
- **Errors**: `application/problem+json` with a stable machine `code`
  (e.g. `SECTION_FULL`, `STUDENT_CLEARANCE_HOLD`, `DOCUMENT_EXPIRED`); see
  `src/core/errors/taxonomy.ts` for the code → status mapping.
- **Rate limits**: per-IP, per-route budgets (tighter on login, reservations and document requests).

## Demo accounts (after `npm run seed`)

Password for all: `Password123!`

- Staff: `admin@portal.test`, `registrar@portal.test`, `chair@portal.test`, `instructor@portal.test`,
  `cashier@portal.test`
- Students: `alice.santos@student.portal.test`, `ben.reyes@student.portal.test`,
  `carla.dizon@student.portal.test` — term `2025-2A` is open for enrollment.

## Project layout

```
prisma/           schema.prisma + migrations (0001_init, 0002_hardening) + seed
scripts/          generate-openapi.ts
src/
  config/         environment loading and defaults
  core/           crypto (jwt, hash, canonical json), errors/taxonomy, http, time (clock)
  infra/          prisma, redis, queues (BullMQ + inline), storage (fs/s3 presign)
  modules/        audit, iam, academics, enrollment, grading, documents
  app.ts          composition root (services + routes)
  workers.ts      background worker entry
  main.ts         API entry
tests/            unit + integration suites and embedded infra helpers
RECONSTRUCTION_LEDGER.md   requirements-to-implementation mapping (BSL-###, INV-#)
```

## Production notes

- Run `npm run prisma:deploy` as part of rollout; the hardening migration installs triggers and
  EXCLUDE constraints that the application relies on.
- Give the API role a non-superuser account once `btree_gist` is provisioned.
- Set `REDIS_REQUIRED=true` so the service fails fast instead of silently degrading to the
  database-only path; workers (`src/workers.ts`, `WORKERS_ENABLED=true`) can be scaled separately.
- Rotate `JWT_ACCESS_SECRET` / `DOCUMENT_HMAC_SECRET` with a rollout plan: rotating the HMAC
  secret invalidates verification of previously issued documents.
