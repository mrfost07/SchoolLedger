# Security & Correctness Audit Report

**Project:** SchoolLedger — headless school information system backend (SIS)
**Date:** 2026-10-16
**Scope:** full src/, prisma/, tests/ — module-by-module review, concurrency/security/performance analysis
**Method:** read every module end-to-end, cross-checked against `RECONSTRUCTION_LEDGER.md` obligations (BSL-xxx, INV-1..7), executed the full test suite before and after fixes. Every finding below cites the file it lives in; every fix has a passing regression test unless explicitly noted.

---

## 1. Verification baseline (pre-fix)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | clean |
| Build | `npm run build` | clean |
| Tests | `npm test` | 12 files / 78 tests green (~84s) |
| OpenAPI | `openapi.json` | 61 paths, OpenAPI 3.1.0; live spec at `GET /api/docs/json` |

## 2. Findings fixed in this audit

### 2.1 Refresh-token rotation race — HIGH
`src/modules/iam/sessions.ts` (`rotate`).
The previous read-verify-write sequence was not atomic: two concurrent presentations of the same refresh token could both pass the `currentHash` check and both obtain live successor tokens; the loser would later be misclassified as reuse and kill a healthy family.
**Fix:** rotation now runs as a single Redis `EVAL` Lua script (`ROTATE_SCRIPT`) — read, compare, revoke-or-rotate happens atomically; the loser is treated as genuine reuse and the family is revoked.
**Regression:** `tests/integration/iam-auth.spec.ts` → “serializes concurrent rotations of the same refresh token (exactly one winner)” — asserts exactly one `200`, one `401 REFRESH_TOKEN_REUSED`, and that even the winner’s successor is dead afterward.

### 2.2 Enrollment unit-cap TOCTOU — HIGH
`src/modules/enrollment/enrollment.service.ts` (`commitReservation`).
`maxAcademicUnits` and duplicate-item checks ran *outside* the transaction. Two concurrent reservations for the same student in *different* sections could each pass and total over the cap (section row locks don’t serialize different sections).
**Fix:** `SELECT pg_advisory_xact_lock(1, hashtext(studentId))` at the top of the transaction, plus an authoritative re-read/re-check of active items and committed units inside the transaction. Lock-class namespace `1` is distinct from the audit chain’s bigint key; deterministic, deadlock-free ordering preserved (student lock → section locks).
**Regression:** `tests/integration/enrollment-guards.spec.ts` → “same-student concurrent reservations across sections respect the unit cap” — 20 + 20 units vs. limit 30 yields exactly one `201`, the other `422 MAX_UNITS_EXCEEDED`, and exactly one persisted item.

### 2.3 Double-decrement on concurrent drops — HIGH
`src/modules/enrollment/enrollment.service.ts` (`dropItem`).
Item status was read before the transaction and counters decremented unconditionally: two concurrent drops of the same item serialized on the section lock but both decremented `enrolledCount` (undercount → stuck capacity, stale waitlists).
**Fix:** item is re-read *inside* the transaction under the section `FOR UPDATE`; the counter update is a single conditional decrement (`updateMany` with `gt: 0` guard) tied to the actual status transition; a second concurrent drop fails with `422 NOT_ENROLLED`.
**Regression:** `tests/integration/enrollment-guards.spec.ts` → “concurrent drops of the same item decrement the section counter exactly once” — one `200`, one `NOT_ENROLLED`, final `enrolledCount = 0`, `waitlistCount = 0`.

### 2.4 Login timing oracle (user enumeration) — MEDIUM
`src/modules/iam/passwords.ts`, `src/modules/iam/iam.service.ts` (`login`).
Unknown emails skipped Argon2id entirely (~ms vs ~50ms), making account existence measurable.
**Fix:** `verifyPasswordTimingSafe` verifies against a lazily-computed throwaway hash when the account/hash is missing, so both paths pay one full Argon2id verification. Error shape unchanged (`401 AUTH_INVALID_CREDENTIALS`).

### 2.5 Stuck idempotency keys + unbounded table growth — MEDIUM
`src/core/http/idempotency.ts`, `src/workers.ts`, `src/main.ts`.
A row left `IN_PROGRESS` by a process crash blocked its key with `409` for its full 24h TTL, and expired rows were never reaped (unbounded growth).
**Fix:** on unique-conflict, a row whose `expiresAt` has passed is deleted and the key re-claimed (self-healing); `cleanupExpiredIdempotencyKeys()` runs hourly on the existing INC-sweep worker (single-writer).
**Regression:** `tests/integration/enrollment-flow.spec.ts` → “reclaims an idempotency key whose TTL elapsed instead of blocking it forever”.

### 2.6 Official-document download ignored holds — MEDIUM (BSL-007)
`src/modules/documents/documents.service.ts` (`download`).
Holds were enforced at issuance but not at download; a hold filed after issuance did not block retrieval of an official document.
**Fix:** `assertClearance(studentId, { forOfficialDocument: true })` is re-evaluated before presigning for `OFFICIAL_DOCUMENT_TYPES` (TOR_OFFICIAL, CERT_GRADES, CERT_GOOD_MORAL).
**Regression:** `tests/integration/documents-flow.spec.ts` → in the holds test: hold re-applied after `READY` → `422 STUDENT_CLEARANCE_HOLD`; after lift → `200`.

### 2.7 Double-payment race on assessments — MEDIUM
`src/modules/enrollment/fees.service.ts` (`markPaid`).
Two concurrent pay calls could both flip `ASSESSED → PAID` and write two audit rows.
**Fix:** conditional `updateMany({ status: 'ASSESSED' })`; the loser observes `PAID` and returns the row without emitting a second audit entry. Boundaries (paying `VOID`) preserved.
**Regression:** `tests/integration/enrollment-flow.spec.ts` → “marks an assessment PAID once under concurrent payment and audits once” — two concurrent `200`s, exactly one `enrollment.assessment.paid` audit row.

### 2.8 Requisite-graph DAG TOCTOU — LOW/MEDIUM
`src/modules/academics/academics.service.ts` (`upsertRequisite`).
Cycle validation read the whole edge list outside the write transaction; two concurrent upserts could close a cycle that neither observed alone.
**Fix:** validation moved inside the transaction behind a global advisory lock (`pg_advisory_xact_lock(2, 0)`) so every committed edge is visible to the check.

### 2.9 Dead code removed
- `src/core/crypto/tokens.ts`: `randomId`, `documentSerial` (only self-referenced; real serials come from `documents/signing.ts`).
- `src/modules/iam/sessions.ts`: unused `isFamilyActive`.
- `src/core/http/idempotency.ts`: unused `parseCompletedRow` + `CompletedRow`.
- `src/infra/prisma.ts`: unused `PrismaTypes` re-export.

## 3. Observations & notes (no code change; documented risks)

| # | Area | Observation | Severity |
|---|---|---|---|
| N1 | `prisma/migrations/0002_hardening` | The `POSTED → SUPERSEDED` trigger compares value/isInc/student/course/term/section/sheet/hash/version but permits mutating `prevHash`, `prevEntryId`, `incDeadlineAt`, `rectificationId` in that one transition. No service path does this; a future tightening migration could compare those columns too. | Low |
| N2 | `src/modules/audit/audit.service.ts` | A single global advisory lock serializes every append (chain integrity) and is held until commit. Correct, but a throughput ceiling for bulk operations; consider per-shard chains if write volume demands it. `verifyChain` is O(n) over the whole log. | Info |
| N3 | `src/modules/documents/documents.service.ts` | `document.expiresAt` is never populated, so the `EXPIRED` status path is defensive only; URL lifetime is enforced by the presign `exp` + signature (tested, 410). | Info |
| N4 | `src/core/http/auth.ts` | Access tokens are stateless; `logout-all` shortens refresh sessions immediately but an already-issued access token remains valid up to its 15-min TTL. Standard trade-off; a denylist would add a Redis hit per request. | Info |
| N5 | `src/modules/enrollment/waitlist.worker.ts` | Promotion does not re-check `maxAcademicUnits` — deliberate per ledger (waitlisted students were admissible when they joined). Window is re-asserted before promotion. | Info |
| N6 | `src/modules/enrollment/capacity.ts` | `DatabaseCapacityGate.tryReserve`/`ensureInitialized` are effectively unused: with no Redis the reserve path skips the gate and relies on row locks + the `enrolledCount <= maxCapacity` CHECK; the classes exist to satisfy the degraded-mode interface. | Info |
| N7 | `src/modules/enrollment/enrollment.service.ts`, `fees.service.ts`, `src/modules/iam/holds.service.ts` | Business timestamps there use wall clock instead of `ctx.clock` (tests use `MutableClock` elsewhere). Immaterial for correctness today; noted for consistency. | Info |
| N8 | `src/modules/documents/documents.worker.ts`, `src/workers.ts` | PDF rendering (pdf-lib) is CPU-bound and, in single-process deployments, shares the event loop with the API (worker concurrency 2). For scale, run workers as separate processes (`WORKERS_ENABLED` is already decoupled). | Scale |
| N9 | `src/modules/enrollment/enrollment.service.ts` (`listWaitlist`) | Unbounded result set (no `take`). Low risk at current scale; add pagination if waitlists grow. | Scale |
| N10 | `src/modules/grading/grading.service.ts` (`postSheet`) | `prevHash` is resolved per-entry inside the posting transaction; concurrent postings for the same (student, course) across sections/terms are serialized only by the sheet-level transaction and the partial-unique index. No practical path exists (one sheet per section, unique active entry), but the chain is not globally locked. | Low |
| N11 | Redis degraded mode | `redisRequired=false` degradation is decided at boot; Redis dying mid-run surfaces as request errors (correct fail-loud behavior) and no auto-recovery. | Info |

## 4. Latency & scalability summary

- **Hot paths:** reserve (advisory lock + sorted section row locks + conditional decrements + audit append) is O(sections); drop is O(1) + promotion enqueue; document request is O(1) + inline/BullMQ render; GWA computation is O(entries) per student, bounded by ledger size.
- **Serialization points:** audit-chain advisory lock (every write, held to commit — N2), per-student enrollment advisory lock (only same-student concurrency), section row locks (only same-section). Cross-student traffic on different sections does not contend (proven by the 50-way race test).
- **DB indexes:** hot lookups are covered (`enrollment_items_sectionId_status_createdAt`, `grade_ledger_entries_studentId_courseId_status`, `document_requests_serialHash`, idempotency unique `(userId,key)` + `expiresAt`). Capacity and schedule invariants are enforced by CHECK + `btree_gist` EXCLUDE constraints, so no application-level scan is needed for correctness.
- **Background work:** documents (concurrency 2), waitlist (4), INC sweep (1, hourly) — all idempotent and safe under re-delivery; INC sweep and idempotency reaping share a single-writer job.
- No benchmark harness was run; the figures above are structural (lock/graph analysis), not measured latencies.

## 5. Post-fix verification

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm test` | **13 files / 83 tests green** |
| New regression tests | 5 (token-rotation race, unit-cap race, double-drop, expired idempotency key, concurrent payment) + extended documents hold test |
| Ledger | §8 updated (new file mapping, 13/83 figures) |

## 6. Residual risk statement

No open HIGH or MEDIUM correctness/security defects remain within the audited scope. The notes in §3 are deliberate design trade-offs or scaling observations; the strongest candidates for a follow-up iteration are N1 (tighten the supersede trigger) and N8 (dedicated worker processes under load).
