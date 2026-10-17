# ADR-0005: Notifications — outbox queue, event listeners, per-school transport

- Status: accepted (Phase 0, 2026-10-17)
- Evidence: `gibbon.md` (notification events on relative dates; messenger targets +
  receipts), `fedena.md` (SMS to parents, single events feed), EDUPro demo IA
  (announcements prominence)

## Context

Today we have BullMQ (waitlist, documents, INC workers) and audit-only email stubs —
no user-facing notification system. The references converge on: announcement targeting
(role/class/group), event listeners on relative dates (due soon, exam soon), delivery
with receipts, and a single feed per user (announcements + dues + exams).

## Decision

- **Notifications are outbox-first**: producers write `Notification` rows (schoolId,
  audience selector, channel set, template key, data payload, dedupe key) inside the
  same transaction as the triggering mutation; delivery is a worker concern (BullMQ),
  states `QUEUED|SENT|DELIVERED|FAILED` with retry/backoff and receipts.
- **Audience targeting is data**: roles, section rosters, year levels, guardian links,
  explicit user lists — resolved at send time; announcements are first-class
  (`Announcement` rows with publish window), separately pinnable in feeds.
- **Event listeners** subscribe to domain events (existing event-bus discipline) and
  translate to notifications via relative-date rules ("FINANCIAL hold placed → notify
  student + guardian; fee due in 3 days → remind") — rules are config rows per school,
  seeded from mode templates, not hardcoded switches.
- **Transport is per-school in SaaS, per-deployment in self-hosted**: email (SMTP/SES),
  SMS (provider interface like payments, ADR-0006 style), in-app always. Credentials
  live in school settings (encrypted at rest), never env-only.
- **Feed composition**: user-facing "week/notices" resolves from announcements +
  notification mirror + calendar events — one query surface (Fedena single-calendar
  lesson) with scope flags.

## Consequences

- Delivery idempotent via dedupe keys (`announcement:{id}:user:{id}`); no double-send
  under retries/races.
- Notification volume is bounded by audience resolution at send time; preference center
  (opt-outs per channel/category) is a Phase 8 slice, schema-ready from the start.
- Existing audit events and notification events stay separate (compliance vs UX).

## Alternatives rejected

- Fire-and-forget emails in request handlers: loses receipts, retries, and audit tie-in.
- Global SMTP-only config: breaks per-school branding/senders in SaaS and self-hosted.
