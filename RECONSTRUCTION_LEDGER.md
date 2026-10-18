# RECONSTRUCTION LEDGER — SchoolLedger (SIS)

> **Artifact status:** Phase 0 reverse-engineering output.
> Every behavioral obligation implemented by this backend carries a **evidence ID** (`BSL-###` = baseline
> obligation), the rule text, the implementing file, and the test that proves it.

---

## 0. REA (morluto/rea) Execution Report

| Item | Result |
| --- | --- |
| `./_targets/` directory | **Absent** — no legacy `.NET` binaries, Electron/JS bundles, `.apk` files, or `.har` captures were provided. |
| REA MCP server (`morluto/rea` / `rea-agents`) | **Not reachable from this build environment** (no MCP transport configured). Discovery runs (`analyze-javascript-application`, `trace_application_feature`, `trace_javascript_semantics`, `investigate_feature`, `audit_residual_unknowns`) were therefore **not executed**. |
| Fallback (per mandate) | The ledger is initialized from **standard higher-education SIS specifications**: CHED/Registrar-aligned credit units, prerequisite DAGs, numeric grade scales, auditable grade sheets. All such obligations are marked `BSL-###`. |

**Re-verification instruction:** if reference artifacts are later dropped into `./_targets/`, re-run REA tooling
and diff findings against `BSL-###` rows; rows without REA corroboration remain `residual: UNVERIFIED`.

---

## 1. Identity, Roles, and Access Obligations

| ID | Obligation | Rule | Implementation | Verification |
| --- | --- | --- | --- | --- |
| BSL-001 | Roles | Exactly six roles: `STUDENT`, `INSTRUCTOR`, `PROGRAM_CHAIR`, `REGISTRAR`, `CASHIER`, `ADMIN`. Multi-role users supported. | `prisma/schema.prisma` enum `Role`; `src/core/http/auth.ts` | `tests/integration/iam.spec.ts` |
| BSL-002 | Access tokens | JWT access token, **15 min TTL**, claims `sub`, `sid`, `roles`, `mfa`, `mfaAt`, `typ=access`. | `src/modules/iam/tokens.ts` | `tests/integration/iam.spec.ts` |
| BSL-003 | Refresh rotation | Refresh tokens are opaque 256-bit secrets, stored **hashed** in Redis with rotation on every use, TTL 30 d. | `src/modules/iam/sessions.ts` | `tests/integration/iam.spec.ts` |
| BSL-004 | Reuse detection | Presenting an already-rotated refresh token revokes the entire token family and appends a security audit event. | `src/modules/iam/sessions.ts` (`REFRESH_TOKEN_REUSED`) | `tests/integration/iam.spec.ts` |
| BSL-005 | Step-up MFA | TOTP (RFC 6238, 30 s step, 6 digits, ±1 window) is **mandatory** for grade submission, grade posting, and official transcript issuance. MFA elevation is a JWT claim valid 5 min. | `src/modules/iam/totp.ts`, `src/core/http/auth.ts` (`requireStepUpMfa`) | `tests/integration/iam.spec.ts`, `tests/integration/grading-flow.spec.ts` |
| BSL-006 | Instructor ABAC | Grade input allowed iff `section.instructorId === user.id` **AND** `term.status === 'GRADING'` **AND** `now ∈ [term.gradingStartAt, term.gradingEndAt]`. | `src/modules/academics/guards.ts` (`assertInstructorCanGrade`) | `tests/integration/grading-flow.spec.ts` |
| BSL-007 | Clearance ABAC | Active holds (`FINANCIAL`, `DISCIPLINARY`) block self-enrollment; **any** active hold (`+ DOCUMENTARY`) blocks official document issuance/download. Holds are time-bounded (`startsAt`, `endsAt?`, `liftedAt?`). | `src/modules/enrollment/guards.ts` (`assertStudentClearance`) | `tests/integration/enrollment-flow.spec.ts`, `tests/integration/documents-flow.spec.ts` |
| BSL-008 | Audit chain | Append-only `audit_logs`. `entry_hash = sha256(prev_hash ‖ actor_id ‖ action ‖ resource_type ‖ resource_id ‖ canonical_json(payload) ‖ iso_timestamp)`. Chain append serialized with `pg_advisory_xact_lock`. UPDATE/DELETE blocked by DB trigger. | `src/modules/audit/audit.service.ts`, migration `0002_hardening` | `tests/unit/audit-chain.spec.ts`, `tests/integration/audit.spec.ts` |

## 2. Academic Structure Obligations

| ID | Obligation | Rule | Implementation | Verification |
| --- | --- | --- | --- | --- |
| BSL-101 | Credit units | A course carries `lectureUnits` and `labUnits`; billable/total units = lecture + lab. Curriculum totals per year/term drive progression. | `Course` model; `src/modules/enrollment/fees.service.ts` | `tests/unit/fees.spec.ts` |
| BSL-102 | Curriculum (prospectus) | Students are bound to an immutable-as-used `CurriculumVersion` (`DRAFT → ACTIVE → ARCHIVED`); courses placed by `yearLevel` + `termNo`. | `CurriculumVersion`, `CurriculumCourse` | `tests/integration/enrollment-flow.spec.ts` |
| BSL-103 | Prerequisite DAG | Requisites: `PREREQUISITE`, `COREQUISITE`, `CONCURRENT`. The requisite graph must be a DAG; self-loops and cycles rejected with structured diagnostics (Kahn + DFS). | `src/modules/academics/dag.ts` | `tests/unit/dag.spec.ts` |
| BSL-104 | No double booking | A room or instructor may not have two overlapping schedules in the same term/day. Enforced by Postgres `btree_gist` `EXCLUDE USING gist` **and** service-level interval diagnostics. | migration `0002_hardening`; `src/modules/academics/conflicts.ts` | `tests/unit/conflicts.spec.ts`, `tests/integration/academics.spec.ts` |
| BSL-105 | Term lifecycle | `PLANNING → ENROLLMENT → ADD_DROP → ONGOING → GRADING → CLOSED`. Enrollment mutations permitted iff `now ∈ [enrollmentStartAt, addDropEndAt]`. Grading window is explicit (`gradingStartAt`, `gradingEndAt`). | `AcademicTerm`, `src/modules/enrollment/enrollment.service.ts` | `tests/integration/enrollment-flow.spec.ts` |

## 3. Enrollment Obligations

| ID | Obligation | Rule | Implementation | Verification |
| --- | --- | --- | --- | --- |
| BSL-201 | Eligibility | A course is *eligible* iff every `PREREQUISITE` has a **POSTED** non-superseded grade with `value ≤ PASSING_GRADE_MAX (3.00)`; `INC` never satisfies a prerequisite. `COREQUISITE`/`CONCURRENT` are satisfied by co-enrollment in the same reservation request or term. Blocked courses report the exact missing prerequisite IDs. | `src/modules/enrollment/eligibility.service.ts` | `tests/unit/eligibility.spec.ts`, `tests/integration/enrollment-flow.spec.ts` |
| BSL-202 | Atomic slot reservation | Slot counters are **Redis-authoritative admission control** (Lua script checks capacity *and* student schedule overlap *and* decrements atomically across all requested sections). Postgres remains the **source of truth**: row locks taken in deterministic `section_id ASC` order (`SELECT … FOR UPDATE`), capacity re-verified, `enrolledCount` incremented. | `src/modules/enrollment/lua/reserve_slots.lua`, `src/modules/enrollment/capacity.ts`, `src/modules/enrollment/enrollment.service.ts` | `tests/unit/reserve-slots-lua.spec.ts`, `tests/integration/enrollment-race.spec.ts` |
| BSL-203 | Capacity invariant | Under arbitrary concurrency `enrolledCount ≤ maxCapacity` (also a DB `CHECK`). 50 concurrent reserves against a section of capacity 5 must yield exactly 5 successes / 45 `SECTION_FULL` failures. | constraints in migration `0002` | `tests/integration/enrollment-race.spec.ts` |
| BSL-204 | Waitlist FIFO | Drops during the add/drop window promote the oldest `WAITLISTED` item that still passes eligibility + conflict checks; promotion is idempotent and re-enqueued while capacity remains and waiters exist. | `src/modules/enrollment/waitlist.worker.ts` | `tests/integration/enrollment-flow.spec.ts` |
| BSL-205 | Assessment | Tuition = `Σ unitFee × (lectureUnits)`; Lab = `Σ labFee × labUnits` (lab-bearing courses only); Miscellaneous = flat catalog items; discount = scholarship % applied to subtotal. Breakdown is **immutable** once `ASSESSED` (snapshot JSON + hash); only `PAID`/`VOID` transitions allowed afterwards. | `src/modules/enrollment/fees.service.ts` | `tests/unit/fees.spec.ts`, `tests/integration/enrollment-flow.spec.ts` |
| BSL-206 | Max load | A student may not enroll/reserve more than `MAX_ACADEMIC_UNITS` (default 30) units per term; overrides require `ADMIN`/`REGISTRAR` flag on the request. | `src/modules/enrollment/enrollment.service.ts` | `tests/integration/enrollment-flow.spec.ts` |

## 4. Grading Obligations (state machine & GWA engine)

### 4.1 Grade scale (BSL-301)

| Mark | Meaning | Counts in GWA | Prerequisite satisfaction |
| --- | --- | --- | --- |
| 1.00–3.00 (0.25 steps) | Passed | Yes (exact value) | Yes if ≤ 3.00 |
| 4.00 | Conditional failure / remedial | Yes | No |
| 5.00 | Failed | Yes | No |
| `INC` | Incomplete | **No** | No |
| `DRP` | Officially dropped | No | No |

### 4.2 State machine (BSL-302)

```
DRAFT ──submit(Instructor+MFA)──▶ SUBMITTED ──verify(ProgramChair)──▶ VERIFIED ──post(Registrar+MFA)──▶ POSTED
                                                                                                        │
                                                       Rectification (Instructor → Chair → Registrar)   ▼
                                                                                                   SUPERSEDED
```
* Rows are **append-only**; a rectification inserts a new entry with `version + 1` and `prevEntryId` linking the superseded row.
* POSTED rows are immutable at the **database layer** (trigger `enforce_grade_immutability`) and the service layer (`GRADE_IMMUTABLE`).

| ID | Obligation | Rule | Implementation | Verification |
| --- | --- | --- | --- | --- |
| BSL-302 | Monotonic transitions | Only the transitions above are legal; skipping a stage or regressing is rejected (`GRADE_STATE_INVALID`). | `src/modules/grading/state-machine.ts` | `tests/unit/grade-state-machine.spec.ts`, `tests/integration/grading-flow.spec.ts` |
| BSL-303 | One active entry | Exactly one non-`SUPERSEDED` ledger entry per `(student, course, term)` — partial unique index. | migration `0002` | `tests/integration/grade-immutability.spec.ts` |
| BSL-304 | INC lifecycle | `INC` entries carry `incDeadlineAt = postedAt + 365 d`. Completion posts a numeric entry (supersedes INC). An hourly sweep converts expired INC entries to `INC_DEFAULT_GRADE (5.00)` by SYSTEM actor with audit trail. | `src/modules/grading/inc.worker.ts` | `tests/integration/inc-lifecycle.spec.ts` |
| BSL-305 | Rectification workflow | POSTED changes require `GradeRectificationRequest`: `PENDING → CHAIR_ENDORSED → APPROVED | REJECTED | CANCELLED`. Only approval mutates the ledger (supersede + v+1 insert, both hash-linked). | `src/modules/grading/rectification.service.ts` | `tests/integration/grade-immutability.spec.ts` |
| BSL-306 | GWA (fixed point) | `GWA = Σ(value × units) / Σ(units)` over POSTED, non-superseded numeric marks (INC/DRP excluded). All arithmetic via `decimal.js`, `ROUND_HALF_UP` to 4 dp; comparisons exact. | `src/modules/grading/gwa.ts` | `tests/unit/gwa.spec.ts` |
| BSL-307 | Standing | Dean's Lister: term GWA ≤ 1.45, full load (≥ 15 units), no mark > 2.00, no INC/failing. `GOOD_STANDING`: cumulative GWA ≤ 3.00 with no outstanding failures. `PROBATION`: cumulative > 3.00 or ≥ 1 failing mark. `DISQUALIFIED`: ≥ 2 consecutive probation terms (configurable). | `src/modules/grading/gwa.ts` | `tests/unit/gwa.spec.ts` |
| BSL-308 | Honors | Summa ≤ 1.20, Magna ≤ 1.45, Cum Laude ≤ 1.75, on the **final cumulative** GWA, no mark below 2.50, residency ≥ 75% units. | `src/modules/grading/gwa.ts` | `tests/unit/gwa.spec.ts` |
| BSL-309 | Transmutation | Percentage → point using the institutional band table (kept in code as the authoritative table; `BSL-309` table below). | `src/modules/grading/gwa.ts` | `tests/unit/gwa.spec.ts` |

**Transmutation table (BSL-309, baseline — confirm with Registrar):**

| % | Point | % | Point | % | Point |
| --- | --- | --- | --- | --- | --- |
| 96–100 | 1.00 | 78–80 | 2.50 | 60–62 | 4.00 |
| 93–95 | 1.25 | 75–77 | 2.75 | 57–59 | 4.50 |
| 90–92 | 1.50 | 72–74 | 3.00 | 0–56 | 5.00 |
| 87–89 | 1.75 | 69–71 | 3.25 | | |
| 84–86 | 2.00 | 66–68 | 3.50 | | |
| 81–83 | 2.25 | 63–65 | 3.75 | | |

## 5. Document Factory Obligations

| ID | Obligation | Rule | Implementation | Verification |
| --- | --- | --- | --- | --- |
| BSL-401 | Lifecycle | `QUEUED → PROCESSING → READY → (EXPIRED | REVOKED)`, or `FAILED`. Worker renders from a **frozen snapshot**; rendering never reads live tables after freezing. | `src/modules/documents/documents.worker.ts` | `tests/integration/documents-flow.spec.ts` |
| BSL-402 | Provenance | `snapshotHash = sha256(canonical_json(snapshot))`; `signature = HMAC-SHA256(DOCUMENT_HMAC_SECRET, snapshotHash)`; serial `DOC-<yyyy>-<8 Crockford chars>`; `serialHash = sha256(serial ‖ snapshotHash ‖ signature)`. QR encodes the public verification URL for `serialHash`. | `src/modules/documents/signing.ts` | `tests/unit/document-signing.spec.ts` |
| BSL-403 | Download | Downloads issue **5-minute** pre-signed URLs (S3 presigner, or HMAC-signed local URL for the FS driver) and append a `document_download_events` row. | `src/modules/documents/documents.service.ts` | `tests/integration/documents-flow.spec.ts` |
| BSL-404 | Public verification | `GET /api/v1/public/verify/:serialHash` (unauthenticated, rate-limited) returns cryptographic validity, issuer metadata, and a **redacted** summary (masked name, program code, doc type, issue date). No PII beyond the redaction contract. | `src/modules/documents/documents.routes.ts` | `tests/integration/documents-flow.spec.ts` |
| BSL-405 | Closed document set | `COR`, `GRADE_SLIP`, `TOR_UNOFFICIAL`, `TOR_OFFICIAL`, `CERT_GRADES`, `CERT_GOOD_MORAL`, `CERT_ENROLLMENT`. `TOR_OFFICIAL` additionally requires **step-up MFA**. | `src/modules/documents/documents.routes.ts` | `tests/integration/documents-flow.spec.ts` |

## 6. Concurrency Invariants (verify_reconstruction targets)

| INV | Statement | Mechanism |
| --- | --- | --- |
| INV-1 | `enrolledCount ≤ maxCapacity` under arbitrary concurrency | Redis Lua admission + `FOR UPDATE` ordered locks + DB `CHECK` |
| INV-2 | No overlapping room/instructor bookings | `btree_gist` EXCLUDE constraints |
| INV-3 | Requisite graph is acyclic | Kahn/DFS validator on every write |
| INV-4 | One active grade entry per `(student, course, term)` | Partial unique index |
| INV-5 | POSTED grades immutable without approved rectification | Trigger + service guard |
| INV-6 | Audit hash chain continuity | Advisory-locked append + `verifyChain` recomputation |
| INV-7 | No schedule overlaps per student (incl. concurrent requests) | Redis interval registry inside Lua + service check |

## 7. Residual Unknowns (`audit_residual_unknowns` — baseline inventory)

| # | Unknown | Impact | Mitigation in code |
| --- | --- | --- | --- |
| R-01 | Exact transmutation bands are institution-specific (band boundaries shown are the baseline, not a captured source) | Cosmetic grade edge cases | Single authoritative `TRANSMUTATION` table in `gwa.ts`; swap bands without code changes elsewhere |
| R-02 | INC expiry default grade (school may use re-enrollment instead of 5.00) | Grading outcomes | `INC_DEFAULT_GRADE` env, default 5.00 |
| R-03 | Max load / overload approval flow | Enrollment policy | `MAX_ACADEMIC_UNITS` env + `allowOverload` flag (REGISTRAR/ADMIN only) |
| R-04 | Dean's Lister full-load unit floor (15 assumed) | Standing | `gwa.ts` constant, documented |
| R-05 | Scholarship stacking policy (only best discount applied) | Fees | Best-discount-wins rule enforced in `fees.service.ts` |
| R-06 | Term status flip automation (who advances `ADD_DROP → ONGOING`) | Ops | Registrar endpoint `POST /academics/terms/:id/status` with transition guard |
| R-07 | Retention/graduation rules beyond standing | Reports | Out of scope for v1; ledger flag |

## 8. Traceability (verify_reconstruction checklist)

| Deliverable | Artifact | Status |
| --- | --- | --- |
| Ledger | `RECONSTRUCTION_LEDGER.md` | ✅ this file |
| Ops guide | `README.md` | ✅ |
| Infra | `docker-compose.yml` (Postgres 16 / Redis 7 / MinIO) | ✅ |
| Schema + hard constraints | `prisma/schema.prisma` + `prisma/migrations/*` (btree_gist, triggers, partial indexes) | ✅ |
| Error taxonomy | `src/core/errors/*` (RFC 7807) | ✅ |
| Idempotency | `src/core/http/idempotency.ts` | ✅ |
| IAM + Audit | `src/modules/iam`, `src/modules/audit` | ✅ |
| Academics + DAG + conflicts | `src/modules/academics` | ✅ |
| Enrollment engine | `src/modules/enrollment` (`reserve_slots.lua`, workers, fees) | ✅ |
| Grading engine | `src/modules/grading` (state machine, INC worker, decimal GWA) | ✅ |
| Document factory | `src/modules/documents` (pdf-lib, HMAC, QR, presign, public verify) | ✅ |
| OpenAPI 3.1 | `openapi.json` (61 paths) + live spec `GET /api/docs/json` | ✅ |
| Race proof (INV-1) | `tests/integration/enrollment-race.spec.ts` — 50 concurrent, capacity 5 | ✅ |
| Concurrency guards (unit cap, drop idempotence, token rotation) | `tests/integration/enrollment-guards.spec.ts` + `iam-auth.spec.ts` | ✅ |
| Auth/session proof (BSL-001..005) | `tests/integration/iam-auth.spec.ts` | ✅ |
| Enrollment lifecycle proof (BSL-201..206) | `tests/integration/enrollment-flow.spec.ts` | ✅ |
| Grading + immutability proof (BSL-302..309, INV-5) | `tests/integration/grading-flow.spec.ts` | ✅ |
| INC lifecycle proof (BSL-304) | `tests/integration/inc-lifecycle.spec.ts` | ✅ |
| Document issuance proof (BSL-401..405) | `tests/integration/documents-flow.spec.ts` | ✅ |
| Ops surface proof (probes + live OpenAPI document) | `tests/integration/ops.spec.ts` | ✅ |
| Unit proofs (DAG, conflicts, GWA, grade state machine, crypto primitives) | `tests/unit/{dag,conflicts,gwa,state-machine,crypto}.spec.ts` | ✅ |

**Consolidated suite note (as-built):** several BSL rows in sections 1–5 name planned
per-obligation spec files; the shipped suite consolidated them. Mapping:
`iam.spec.ts` → `iam-auth.spec.ts`; `academics.spec.ts` / `eligibility.spec.ts` /
`fees.spec.ts` → `enrollment-flow.spec.ts`; `grade-immutability.spec.ts` /
`grade-state-machine.spec.ts` → `grading-flow.spec.ts` + unit `state-machine.spec.ts`;
`audit.spec.ts` / `audit-chain.spec.ts` → unit `crypto.spec.ts` (hash chain) plus audit
assertions inside the integration flows; `document-signing.spec.ts` → unit `crypto.spec.ts`
+ `documents-flow.spec.ts`; `reserve-slots-lua.spec.ts` → `enrollment-race.spec.ts`.
Final verification run (post-audit): 13 files / 83 tests green (`npm test`).

**As-built corrections:** BSL-402 serial format is `SP-<year>-<16 hex chars, upper>` and
`serialHash = sha256(serialNo + "|" + signature)` (the A5 draft text describes an earlier
`DOC-<yyyy>-<8 Crockford>` plan) — see `src/modules/documents/signing.ts`. BSL-005/BSL-405
step-up MFA for `TOR_OFFICIAL` is enforced in `documents.routes.ts` (403 `STEP_UP_REQUIRED`
without a fresh elevation); the hold check applies on top (422 `STUDENT_CLEARANCE_HOLD`).

---

## 9. Frontend client (web app)

Not a reconstruction obligation — the student-facing app built on the audited backend.

| Item | Artifact | Verification |
| --- | --- | --- |
| Design system | `docs/frontend-design.md` (tokens, type, week-grid, error→UX map) | — |
| App | `frontend/` (Next 16, App Router, port 5173; `/api/v1/*` rewritten to `API_ORIGIN`, no CORS needed) | `frontend`: `typecheck` + `lint` + `build` clean (17 routes) |
| Token custody | memory-only access token; httpOnly `sp_rt` cookie via `frontend/src/app/session/*`; single-flight refresh (keyed per token server-side, global client-side) | `frontend/src/tests/refresh-mutex.test.ts` |
| Idempotent writes | `useIdempotentAction` — key kept on failure, reset on success (`reserve`, document `request`) | `frontend/src/tests/idempotency.test.ts` |
| Pure logic | week-grid geometry/conflicts, formatting, error copy, term pick | `frontend/src/tests/*` — 5 files / 45 tests green (`npm test`) |
| Screens | sign-in (+inline MFA), home, enroll (grid + batch reserve/waitlist/drop), schedule, grades, assessment, documents (+detail/step-up download), holds, account (TOTP, session revocation) | build route table (incl. 4 session handlers) |
| End-to-end | `scripts/dev-walkthrough.ps1` (sections A–N) + `scripts/dev-parallel-refresh.mjs`, through the :5173 origin against embedded PG/Redis (`scripts/dev-run.ts`) | 84/0 checks green: session custody, all 8 portal pages, reserve batch + idempotent replay, prereq block, drop/re-reserve, waitlist rejection, COR + CERT_GRADES full cycles (PDF bytes, public verify), TOR role gate (403 `FORBIDDEN`), TOTP enable → step-up → elevated token, hold-gated official download (BSL-007), refresh reuse → family revoked, MFA-required re-login, logout. Mutex proof: concurrent same-cookie refreshes → both 200, one rotation, family intact |
| E2E-caught fixes | step-up now adopts the elevated access token (`use-auth.tsx` `stepUp` → `applyTokens`); student request desk no longer offers `TOR_OFFICIAL` (`REQUESTABLE_DOCUMENT_TYPES`) and the official-doc copy describes the clearance-hold gate instead of a student step-up that cannot occur | gates + walkthrough re-run after both fixes |

---

## 10. Phase 0 — ground truth & design lock (multi-tenant SIS program)

| Item | Artifact | Verification |
| --- | --- | --- |
| Version control baseline | `git init` (branch `main`), `.gitattributes` (LF for code, CRLF for scripts), tag `phase-0-baseline` @ `a447288` | `git log`/`git tag`; no secrets or runtime state committed (`.dev-runtime.json`, `.dev-logs/`, `storage/`, `.next/` ignored) |
| CI skeleton | `.github/workflows/ci.yml` — backend job (npm ci, prisma generate, typecheck, **OpenAPI drift check**, vitest, build) + frontend job (**generated schema drift check**, typecheck, lint, vitest, build) | authored; runs in GitHub CI once a remote is added (no Docker locally — container smoke lands in CI per ADR-0007) |
| Toolchain | Node bumped 22.11 → **24.22.0** via nvm4w; REA `rea-agents@6.5.0` installed (browser capture + inspect + screenshot verified against localhost and public demos) | `rea doctor` (node/host healthy); capture evidence under `tools/reference/scenarios/` (gitignored) |
| Reference teardown | 4 OSS SIS studied at pinned commits (Gibbon v31 `65f86bf`, openSIS CE 9.3 `5d546f2`, Fedena `68a84ac`, OpenEduCat Odoo 19 `46a5d7d`) — read-only, GPL/LGPL = ideas only; notes in `docs/teardown-notes/*` | sub-agent studies cross-checked in `docs/sis-teardown.md` |
| Public demo captures | EduPro CMS demo (vendor-published demo accounts, 2026-10-17): teacher + student dashboard IA + screenshots via REA | `docs/teardown-evidence/*.png`, scenario JSON evidence |
| Design lock docs | `docs/sis-teardown.md` (doctrine, workflow patterns, anti-patterns), `docs/institution-modes.md` (HE vs K-12 matrix) | review checkpoint before Phase 1a |
| ADRs | `docs/adr/0001`–`0007`: multi-tenancy (RLS+`schoolId`), identity (membership+roles-as-data), academic structure (year/term rows, catalog/offering/membership, dated placement), audit/permissions (per-school chains, permission registry, maker-checker), notifications (outbox), payments (ledger-first, installments=100%), self-hosted packaging (`DEPLOYMENT_MODE`, compose, licensing deferred) | accepted Phase 0 |

**Next:** Phase 1a — tenant foundations (School/Membership/RoleAssignment/SchoolPolicy,
`schoolId` + RLS on all tenant tables, per-school audit chains, permission registry +
policy-coverage test, two-school seeds, cross-tenant IDOR suite), keeping the 84-check
walkthrough green with School #1 = current seed.

---

## 11. Phase 1a — tenant foundations (as-built)

| Item | Artifact | Verification |
| --- | --- | --- |
| Tenancy schema | `prisma/migrations/0003_tenancy` — `schools`, `permissions`, `role_templates`, `role_template_permissions`; `schoolId` + FK on all 28 tenant tables; per-school compound uniques (student numbers, code pairs, `[schoolId, schoolYear, termNo]`, `[schoolId, serialNo]`, idempotency `[schoolId, userId, key]`); live-data backfill to School #1 (`MAIN`, fixed UUID) | applied on the dev database with existing rows; `prisma migrate diff` clean (accepted generated-column noise: `section_schedules.timeRange`) |
| RLS (defense in depth) | 28 policies — `app.system='on' OR <tenant column>::text = current_setting('app.current_school_id', true)`; ENABLE + FORCE; role `schoolledger_app` (NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS; password environment-provisioned in `scripts/dev-run.ts` / test infra) | durable probe suite `tests/integration/tenant-isolation.spec.ts` (deny-all without GUCs, `WITH CHECK` insert violation, per-school visibility, system escape hatch). Runtime connections still use the owner role — RLS-GUC propagation is deliberate post-1a debt |
| App-layer enforcement | `src/core/tenant/context.ts` (ALS store; `runWithTenant` / `runWithSystem` await inside the frame so lazy Prisma promises execute scoped) + `extension.ts` (create injection, AND-merge filters, inline unique-where merge for update/delete/upsert, `findUnique` post-verify, fail-closed `TENANT_CONTEXT_MISSING`) | isolation-suite extension block: scoped reads, null cross-school lookup, refused cross-school delete leaving the row intact, schoolId injection safety net |
| Request identity | access tokens carry required `schoolId`; `authenticate()` binds the ALS frame and rejects unscoped tokens; membership-aware login (`AUTH_NO_MEMBERSHIP`); background jobs (`workers.ts`, `queues.ts`, inline dispatcher) run under `runWithTenant(schoolId)` / `runWithSystem` | `iam-auth.spec.ts` + all integration flows |
| Permission registry | `src/modules/iam/permissions.ts` — 48 codes / 6 HE role templates; seeded to `permissions`/`role_templates`; every authenticated route declares `config.permission` (any-of); `onRoute` hook fails startup on missing/unknown codes and enforces the any-of check as a preHandler | 61/61 authenticated routes declared; `npm test` 14 files / 96 tests green; 84-check walkthrough green with enforcement live for all six roles |
| Two-school seed | `prisma/seed.ts` — School #1 `MAIN` (full demo dataset) + School #2 `NORTH` (minimal; proves per-school code uniqueness), memberships + role assignments for every user, permission registry + templates | `dev-reset` + seed + walkthrough green on the two-school baseline |
| Cross-tenant IDOR suite | `tests/integration/tenant-isolation.spec.ts` — HTTP probes (reserve, document detail/download paths, admin user creation against a foreign program, grade ledger, sheet read) + extension + RLS blocks | 13 tests green; full suite 96/96 |

**Next:** Phase 1b — school configuration surface (school profile & policy management,
branding) per the program plan; the 84-check walkthrough remains the regression gate with
School #1 = current seed.
