# ADR-0004: Audit, permissions, integrity — per-tenant chains, registry ACL, maker-checker

- Status: accepted (Phase 0, 2026-10-17)
- Evidence: current `AUDIT_REPORT.md` (global hash chain) + `RECONSTRUCTION_LEDGER.md`;
  `gibbon.md` (Data Updater shadow rows, `isActionAccessible` registry), `opensis.md`
  (URL-string ACL, hardcoded profile IDs — anti-patterns)

## Context

We already ship: append-only audit records with a hash chain, verify-step-up on grade
posting, idempotency keys on mutations, document HMAC signing, clearance holds. All of
it is currently single-tenant and role-string based (`role === 'REGISTRAR'`). Multi-
tenant + multi-role demands explicit structure for: who may do what (per school),
what was done (per school), and how sensitive identity edits flow (maker-checker).

## Decision

1. **Permissions are a registry** (`Permission` rows: module.action, e.g.
   `documents.issue`, `grades.verify`), granted through `RoleAssignment` templates
   seeded per mode. Checks go through `can(actor, permission, scope)`; no URL strings,
   no role-boolean conditionals scattered in routes. New endpoints must register a
   permission — CI fails otherwise (started in Phase 1a policy-coverage test).
2. **Audit chains are per school.** `AuditRecord` gains `schoolId`; hashing chains link
   previous record **within the same school** (genesis per school). Platform-admin
   actions on tenant data are recorded in a separate platform chain that references the
   school — never silently interleaved.
3. **Maker-checker (shadow updates)** for sensitive identity/record edits: family/
   guardian-maintained data (and later parent contact info) writes `*ChangeRequest`
   rows with diffs; staff approve/reject; approval applies via the normal audited path.
   Direct staff edits stay immediate but audited.
4. **Posting windows + step-up stay the two locks on academic records**: computing is
   free, posting respects term posting windows (ADR-0003) and step-up MFA (existing
   `mfaAt` claim); rectifications remain append-only events referencing the original.
5. **Idempotency and HMAC signing extend per-tenant**: idempotency keys are namespaced
   by school; document serials/HMAC secret scope per deployment (self-hosted) with
   per-school serial namespaces.

## Consequences

- Existing tests that assert global-chain behavior adapt to per-school genesis (School
  #1 chain equivalent to today's).
- Route handlers get slimmer (permission registry lookups) while OpenAPI stays the
  contract; policy-coverage test enumerates routes → permissions.
- Every sensistive mutation path passes through one audited service layer; direct prod
  DB edits are out of contract (documented in ops runbook).

## Alternatives rejected

- Keep role-string checks: breaks multi-role/membership model (ADR-0002).
- Global audit chain in shared DB: leaks cross-tenant ordering and couples retention.
