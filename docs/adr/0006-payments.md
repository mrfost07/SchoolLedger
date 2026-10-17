# ADR-0006: Payments & receivables — ledger-first, provider-agnostic, installment-100%

- Status: accepted (Phase 0, 2026-10-17)
- Evidence: `fedena.md` (collection copy-on-create, receipt sequences, CSV txn ids,
  `is_paid` drift — anti-pattern), `openeducat.md` (installments sum to 100%, native
  accounting), `gibbon.md` (invoice-centric fees, polymorphic payments)

## Context

The backend already computes fees deterministically (`fees.service.ts`, Decimal.js) and
the student portal shows assessment amounts, but there is no payment, receipt, or
receivable model. References split between homegrown ledgers (Fedena: brittle), native
accounting suites (OpenEduCat: rich, heavy), and invoice-only (Gibbon: no statements).
We need: cashier desk (Phase 5), online payments later, receipts/OR printing, clearance
integration with existing holds, and self-hosted deployments with no external provider.

## Decision

- **Ledger-first, append-only**: `LedgerEntry` rows (schoolId, student, kind
  `CHARGE|PAYMENT|DISCOUNT|WAIVER|ADJUSTMENT`, amount, currency, term ref, source ref,
  idempotency key). Balances and statements are **derived**, never stored booleans.
  Assessment → charges by an explicit generator job (copy-on-create from the term fee
  plan, per Fedena lesson); plan edits never rewrite issued charges.
- **Receipts are documents**: every payment produces an official receipt document via
  the existing documents worker + HMAC signing/serials (per-school serial namespaces),
  printable and re-deliverable from archive (ADR-0004 documents pattern).
- **Provider-agnostic payments**: `PaymentIntent` (amount, channel `CASH|BANK|CARD|
  EWALLET|CUSTOM`, provider key, externalRef, state) with adapters behind one interface
  — `manual` (cashier) ships first; `stripe`/`paymongo` adapters land later behind the
  same interface. Webhooks are idempotent (reuse existing idempotency hook), and a
  payment only hits the ledger on a verified adapter callback or cashier confirmation.
- **Installments are arithmetic, not vibes**: installment plans must sum to exactly
  100% of the term assessment (OpenEduCat rule), enforced at plan creation; per-student
  installment schedules are generated rows with due dates.
- **Clearance integration**: unpaid-balance holds are placed/lifted through the existing
  holds service (cashier role), and documents clearance checks (existing
  `STUDENT_CLEARANCE_HOLD`) read derived balance — no new gate mechanism.
- Out of scope v1: full double-entry GL. The ledger is designed so a GL layer can be
  added later without migrating history (entry kinds map cleanly).

## Consequences

- Cashier desk (Phase 5) builds on stable primitives; self-hosted works offline/cash.
- Reconciliation becomes query, not state repair; `is_paid`-style drift is impossible.
- Currency stays per-school policy (existing env knob migrates to `SchoolPolicy`).

## Alternatives rejected

- Adopt Odoo-style full accounting now: premature for fees-only scope, heavy for
  self-hosted.
- Invoice-centric only (Gibbon): no statements/arrears view for HE bursar needs.
