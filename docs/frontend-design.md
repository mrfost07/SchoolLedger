# SchoolLedger — Frontend System Design

Status: **plan for approval** (pass 1 of 2 — plan, review, then build)
Scope: student-facing portal only. Next.js + TypeScript + Tailwind. Authored with the `frontend-design` skill workflow.

## 0. Brief and subject

The backend is done (Fastify SIS, 83 tests green). The subject is a fictional **state polytechnic university in Metro Manila: ~20,000 students, commuter-heavy, enrollment windows are competitive, documents (TOR, certificates) gate graduation and first jobs.**

- **Audience:** undergraduate students, 16–22, on mid-range Android phones, mobile data, often between rides. The portal gets checked in glances: *"did I get the slot?"*, *"are grades out?"*, *"is my TOR ready?"*
- **Primary jobs:** (1) enroll fast without mistakes or overselling; (2) read grades without ambiguity; (3) track holds, assessments, and document requests to completion.
- **What the interface must be good at:** dense, real data; exact reasons for any block; zero decoration competing with the one number someone came to see.

If any of this reads wrong (different school profile, different device mix), say so — everything below cascades from it.

## 1. Design plan

### 1.1 Color

The palette comes from the subject's own materials: the registrar's navy ink on cool form paper, the commuter cue of jeepney yellow, and stamps for status. It deliberately avoids the warm-cream/serif/terracotta cluster and the near-black/acid cluster.

| Token | Hex | Role |
|---|---|---|
| `paper` | `#F1F4F2` | Page background. Cool, slightly green-cast form paper — not cream |
| `surface` | `#FFFFFF` | Tables, forms, cards-that-are-forms; lifted by rules, never shadows |
| `ink` | `#1E2A38` | Registrar navy: text, borders, enrolled blocks, buttons |
| `ink-soft` | `#4E5D6B` | Secondary text, labels, unavailable states (~6.3:1 on paper) |
| `rule` | `#C8D2CE` | Hairlines inside ledgers, tables, the week grid — data structure only |
| `signal` | `#F2B705` | Jeepney yellow. Selection, candidate blocks, counts that matter. Always carries `ink` text (~8.8:1) |
| `stamp` | `#B3261E` | Blocked, holds, errors, conflicts. ~5.5:1 on paper |
| `ledger` | `#2F7B5A` | PAID, RELEASED, passed, earned. ~4.7:1 on paper |
| `manila` | `#E8DCC4` | Document request surfaces only — the folder the records live in |

**Status is never color alone.** Every state also carries a form cue:

- open seat → dashed outline, sentence-case label
- enrolled → solid ink block
- candidate (pre-reserve) → signal fill
- waitlisted → diagonal hatching (CSS `repeating-linear-gradient`)
- conflict → stamp outline + one pulse, then still
- blocked/hold → stamp border + the word

### 1.2 Type

Two families, clearly distinct by width, weight, and job. No all-caps, ever.

- **Archivo** — variable (wght 100–900, wdth 62–125). Timetable-signage voice: page titles, ledger section headers, buttons, week-grid block labels. Set wide (`wdth ~110`) and heavy for display; normal width for UI actions.
- **Public Sans** — body, tables, forms, all running text. A government-forms face chosen for legibility at small sizes — this app is a form, and it reads like one, on purpose.

Numerals: every figure (units, grades, GWA, counts, serials) uses `font-variant-numeric: tabular-nums lining-nums` and right alignment in ledgers.

Scale (16px base, ~1.25 ratio, Elements-of-Typographic-Style spacing):

| Token | Size / line | Face | Use |
|---|---|---|---|
| `micro` | 12 / 16 | Public Sans 500 | field hints, timestamps |
| `label` | 13 / 18 | Public Sans 600 | form labels, table column heads (sentence case) |
| `body` | 15 / 23 | Public Sans 400 | running text, table cells |
| `body-lg` | 17 / 26 | Public Sans 400 | comfortable reading |
| `title` | 20 / 26 | Archivo 650 | section titles |
| `display-3` | 26 / 30 | Archivo 700 wdth 108 | page titles |
| `display-2` | 34 / 38 | Archivo 750 wdth 110 | term header, big states |
| `display-1` | clamp(40→56) | Archivo 800 wdth 112 | the one loud number, used rarely |

Line lengths under 80ch; serif-free system so 15px body stands.

### 1.3 Layout

**Concept: the student's record is a form being filled, and the week is its canvas.**

- Phone-first, single column, ≥1024px adds a **232px record rail** on the left: name, student no., current term, standing, sign out. It is the margin of the form — you always know *whose record* and *which term* governs what you are reading. On mobile it compresses to one top strip.
- Content is organized as **ledger rows** (label left, figure right, hairline between rows — rules never wrap content in boxes) and **field rows** for forms.
- **The week grid** is the signature object. Monday–Friday columns, 7:00–20:00 rows at 30-minute steps. This is the only place filled color and motion are allowed to be loud. It is CSS Grid + absolutely positioned block buttons (keyboard navigable), not canvas.
- Alignment: left-aligned text; figures right-aligned; stamps/status centered within their mark. Nothing justified.
- Radius 0 on fields, blocks, tables, buttons (form-paper corner logic). No shadows anywhere; overlays use a scrim. One soft shadow is permitted only under a floating autocomplete sheet, because it genuinely floats.

Wireframes (desktop; mobile collapses each to one column + strip):

**Home — the term desk**
```
┌──────────┬───────────────────────────────────────────────────────┐
│ RECORD   │  2026–1st sem  ENROLLMENT OPEN · closes Fri 23 Oct    │
│ R. Cruz  │                                                       │
│ 2026-... │  ┌ FORM STRIP ──────────────────────────────────────┐ │
│ ──────── │  │ Units reserved    15 / 30      [▨ ENROLLED]      │ │
│ 2026–1st │  │ Assessment        UNPAID · ₱4,120   → cashier     │ │
│ sem      │  │ Holds             none                           │ │
│ ──────── │  └──────────────────────────────────────────────────┘ │
│ Standing │                                                       │
│ Regular  │  TODAY · Tue 20 Oct                                   │
│ ──────── │  ────────────────────────────────────────────────     │
│ [Sign    │  7:30  CS 102 Lec      Rm 204        [mini ▉▉        ] │
│  out]    │  9:30  MTH 101 Lab     Rm 112        [mini ▉▉        ] │
│          │  ────────────────────────────────────────────────     │
│          │  NEXT  INC completion for NSTP 1 · deadline 12 Jan    │
└──────────┴───────────────────────────────────────────────────────┘
```

**Enrollment desk — search left, week right**
```
ENROLLMENT · 2026–1st sem        Eligibility OK · 15/30 units
┌───────────────────────────────┬──────────────────────────────────┐
│ FIND SECTIONS                 │ YOUR WEEK                        │
│ [ CS 102        ] [ day ▾ ]   │      Mon   Tue   Wed   Thu   Fri │
│ ──────────────────────────    │ 7:30  ██████ CS 101 (enrolled)   │
│ CS 102 · A · TTh 7:30–9:00    │ 9:00   ░░░░ waitlisted (hatch)   │
│   3 units · 12 / 40 open      │ 9:30         ▓▓▓▓ candidate      │
│   [ Reserve seat ]            │ 11:30  ██████ MTH 101 (enrolled) │
│ ──────────────────────────    │ 13:00  ✕ conflict with PE 2      │
│ CS 102 · B · TTh 9:30–11:30   │        (red outline, one pulse)  │
│   3 units · FULL              │                                  │
│   [ Join waitlist ]           │  Reserve drops the block in.     │
└───────────────────────────────┴──────────────────────────────────┘
```

**Grades — the ledger**
```
GRADES                                   2025–2nd sem ▾    GWA 1.76
──────────────────────────────────────────────────────────────────
Course        Title                        Units    Grade   Remark
──────────────────────────────────────────────────────────────────
CS 101        Introduction to Computing       3     1.50
MTH 101       Calculus I                      3     2.00
PE 1          Physical Education              2     1.75   Passed
NSTP 1        Civic Welfare Training          3     INC    due 12 Jan
──────────────────────────────────────────────────────────────────
                                  Units earned   11 / 11
```

**Mobile:** rail → strip; week grid → day-tabbed agenda list; search results → full-height sheet with reserve pinned at the bottom.

### 1.4 Principles

1. **The record is the frame.** The rail (or strip) always states whose record and which term — no screen is anonymous.
2. **The week grid is the only loud place.** Fills, hatching, and the one insertion animation live there; everything else is paper, ink, and rules.
3. **Status is stamped, not decorated.** Every status = sentence-case label + a non-color cue. No pills, no shadows, no color-only meaning.
4. **Rules mean data.** A hairline appears only where it separates fields or rows. It is never a decorative divider.
5. **Numbers are sacred.** Tabular, right-aligned, never truncated; units and grades never round silently.
6. **One motion moment:** a reserved section lands in the week. Everything else answers instantly (120 ms) or not with animation at all.
7. **Registrar-plain copy.** Sentence case, verb + object actions, exact block reasons: *"Conflicts with MTH 101 Lab (Thu 11:30). Drop MTH 101 Lab first."*

## 2. Review against the defaults

Checked against the generic clusters this kind of brief usually produces, and revised where needed:

- Cream/terracotta serif hero — **not used**; cool paper + navy ink + stamp semantics instead.
- Near-black + single acid accent — **not used**; navy is ink-on-paper, yellow is subject-derived (commute), and is a fill that carries ink text.
- Broadsheet hairline maximalism — **adjacent risk, contained**: rules exist only inside ledgers/tables/grid as field separators; typography stays single-column, sans, sentence case — no newspaper columns, no zero-space density.
- SaaS card kit (uniform radius, soft shadows, gradient washes) — **not used**; radius 0, no shadows, state encoded flat.
- Template chrome (all-caps eyebrows, `·`-joined meta, `WORD — fragment` labels, `→` buttons) — **banned**; term labels read *"2026–1st sem"*, metadata is labeled rows, buttons are verbs.
- Deliberate cuts (Chanel rule): dropped a monospace family for serials (Public Sans tabular suffices), dropped dark mode from v1, dropped any icon beyond a hand-set SVG minimum.

## 3. Frontend system architecture

Stack: **Next.js 15 (App Router) + TypeScript strict + Tailwind v4 + TanStack Query + openapi-typescript/openapi-fetch.** Node 22. No component library — the token system above is the library.

### 3.1 Rendering model

Deliberate choice: **client-driven app inside Next**, not RSC data-fetching. Access tokens live in memory only (never localStorage); server components render the static shell only. Next is used for tooling, the session cookie endpoints, and same-origin rewrites to the API (no CORS surface). This keeps the interactive week grid simple and the token custody honest.

### 3.2 Auth and token custody

The backend rotates refresh tokens and revokes the whole family on any concurrent reuse detection (verified behavior). The frontend must therefore **never fire two parallel refreshes** — that is a real architectural constraint, not a nicety.

- `POST /session/login` (Next route handler) → calls `POST /api/v1/auth/login`; on success stores the refresh token in an httpOnly `SameSite=Lax; Secure` cookie (`sp_rt`), returns the access token + profile to the client (memory only). MFA `required` response flows into the same handler pattern with `POST /api/v1/auth/mfa/verify`.
- `POST /session/refresh` (Next route handler) → reads the cookie, holds a **per-session in-process mutex** before calling `POST /api/v1/auth/refresh`, sets the rotated cookie, returns the new access token. Concurrent client 401s queue behind the mutex. (Multi-instance deploy: swap the mutex for a Redis `SET NX` lock — the backend Redis is available.)
- Client API middleware (openapi-fetch): attach `Authorization: Bearer`; on `401 TOKEN_EXPIRED` → single-flight `POST /session/refresh` → retry original once.
- `REFRESH_TOKEN_REUSED` / `REFRESH_TOKEN_INVALID` → purge memory, redirect to sign-in with: *"Your session was closed for security. Sign in again."*
- `POST /session/logout` → backend `POST /api/v1/auth/logout`, clear cookie. Account screen exposes *Sign out everywhere* (`POST /api/v1/auth/logout-all`).
- Step-up: `STEP_UP_REQUIRED` (e.g. TOR request) opens a global modal; on `POST /api/v1/auth/step-up` success the original request is retried. `STEP_UP_MFA_NOT_ENROLLED` routes to TOTP setup.

### 3.3 Routes (App Router)

```
/sign-in                      login, MFA step inline
(portal)/
  /              home — the term desk (§1.3 wireframe)
  /enroll        eligibility + section search + week + reserve/drop/waitlist
  /schedule      the week, read-only, term switcher
  /grades        ledger + GWA + INC deadlines
  /assessment    breakdown (read-only) + cashier reference slip
  /documents     list + request (step-up) + status timeline
  /documents/:id detail — serial, verify link, download when READY
  /holds         holds with what-blocks-what mapping
  /account       password, TOTP setup/enable, sessions (logout-all)
```

Light middleware guard: no `sp_rt` cookie → redirect to `/sign-in`. Real validity is enforced by the client auth context on first call.

### 3.4 Data layer

- `npm run gen:api` → `openapi.json` → `openapi-typescript` types + `openapi-fetch` client with problem+json middleware decoding into `AppError { code, message, details }`.
- Query keys: `['me']`, `['term']`, `['enrollments', termId]`, `['eligibility', termId]`, `['sections', filters]`, `['week', termId]`, `['grades', termId]`, `['gwa']`, `['assessment', enrollmentId]`, `['documents']`, `['document', id]`, `['holds', studentId]`.
- **Idempotency:** `POST /api/v1/enrollments/reserve` and `POST /api/v1/enrollments/drop` require a key (`IDEMPOTENCY_KEY_REQUIRED` otherwise). Key = `crypto.randomUUID()` generated once per user intent, held in component state; network retries reuse it; a new intent gets a new key.
- **Document flow polling:** after a request, poll `GET /api/v1/documents/requests/:id` every 3 s while `REQUESTED`/`RENDERING`, stop on `READY`/failure with an inline explanation (retry action available).
- Mutation → invalidation map: reserve/drop → `week`, `enrollments`, `eligibility`, `sections`, `assessment`; waitlist join → `week`, `sections`; document request → `documents`; step-up → none (retry original).
- Assessment payment is **cashier-side only**. The student view shows the breakdown and a reference slip (student no., term, amount) to present at the window; pay route is never called from this app.

### 3.5 Error → interface map (real codes from the backend)

| Code | Interface response |
|---|---|
| `ENROLLMENT_WINDOW_CLOSED` | Banner replaces reserve UI: *"Enrollment is closed for this term."* + window dates |
| `MAX_UNITS_EXCEEDED` | Inline on the reserve button: *"This would put you at 33 of 30 units. Drop a section first."* |
| `ALREADY_ENROLLED` | Section row shows *Enrolled*; the action button is gone |
| `SECTION_FULL` | *"Full."* → waitlist CTA with `WAITLIST_NOT_AVAILABLE` fallback text |
| `SCHEDULE_CONFLICT` / `SCHEDULE_CONFLICT_STUDENT` | Red block in grid + list of conflicting courses by name and time |
| `PREREQUISITE_NOT_MET` / `COREQUISITE_NOT_MET` | *"Needs CS 101 first"* with the unmet course code |
| `STUDENT_CLEARANCE_HOLD` | Stamp-red banner linking to `/holds`: *"Clearance hold. Enrollment and official documents are blocked until the cashier lifts it."* |
| `STEP_UP_REQUIRED` | Global step-up modal, then retry |
| `DOCUMENT_NOT_READY` / `DOCUMENT_EXPIRED` | Download button disabled with state text; expired links re-requested silently with a fresh presign |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` | Disable the control, show *Working…*, allow one retry after 5 s |
| `RATE_LIMITED` | *"Too many attempts. Try again in a minute."* (login screen, from the 10/min limit) |
| `NOT_ENROLLED` | Drop action shows list refresh if the item was already dropped elsewhere |

### 3.6 Quality floor

- **Accessibility:** grid is real buttons in DOM order with arrow-key navigation; `aria-live="polite"` announces reserve outcomes (*"Reserved CS 102 section A. You are now at 18 units."*); focus ring = 2px ink outline + 2px offset, visible on every surface; all state cues redundant with color; contrast AA everywhere (tokens above are specced to it).
- **Motion:** 120/200 ms transitions; the one ceremony is the block landing in the grid (220 ms), skipped entirely under `prefers-reduced-motion` replaced by a static outline flash.
- **Performance (3G-class mobile target):** no images on core flows (type + CSS only), two self-hosted subset fonts via `next/font`, hand-rolled inline SVG set (< 20 glyphs), route-level code splitting, idle prefetch of `/enroll` and `/grades`, LCP target < 2.0 s on a 3G Fast profile.
- **Testing (build pass):** Vitest + Testing Library for grid logic, idempotent reserve hook, error map; Playwright smoke later against the seeded backend (login + MFA, reserve race UX, step-up document request).

## 4. Screen states (empty / blocked / failure copy)

- Grades empty: *"No grades posted for 2026–1st sem yet. They appear after the registrar posts your section's sheet."*
- Documents empty: *"You haven't requested any documents. Request your Transcript of Records when you need it for work or transfer."* → `Request a document`
- Waitlisted: *"Waitlisted · position 3. You'll be promoted automatically when a seat opens — no action needed."*
- Assessment unpaid: *"Unpaid · ₱4,120. Pay at any cashier window and present your student number."*
- All error copy: no apologies, exact cause, one next action.

## 5. Token scaffold (ready for the build pass)

```css
@theme {
  --color-paper: #F1F4F2;   --color-surface: #FFFFFF;
  --color-ink: #1E2A38;     --color-ink-soft: #4E5D6B;
  --color-rule: #C8D2CE;    --color-signal: #F2B705;
  --color-stamp: #B3261E;   --color-ledger: #2F7B5A;
  --color-manila: #E8DCC4;
  --font-display: "Archivo", sans-serif;
  --font-body: "Public Sans", sans-serif;
  --radius-none: 0;
}
/* figures */ .figure { font-variant-numeric: tabular-nums lining-nums; }
/* waitlisted hatching */
.hatch { background-image: repeating-linear-gradient(45deg,
  var(--color-ink) 0 2px, transparent 2px 6px); background-size: 100% 100%; }
```

## 6. Open items before build

1. **Institution color override?** If the university has fixed brand colors, they replace `signal` first, then `ink` — the token system absorbs this without redesign.
2. Term label convention: `2026–1st sem` proposed; match the registrar's real notation if different.
3. Grading scale display: numeric + remark words (Passed/FAILED on 5.00/INC/DRP) — confirm whether `5.00` shows as FAILED in student view.
4. Dark mode deferred by choice; if needed later it becomes the "carbon copy" inverse (paper ↔ ink swapped, signal retained).
