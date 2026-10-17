# Student Portal — Frontend

Next.js 16 (App Router) client for the Student Portal backend. Implements the design in
`../docs/frontend-design.md`: paper/surface/ink ledger aesthetic, Archivo + Public Sans, one
signature element — the enrollment week grid.

## Run it

```powershell
# 1. Backend (repo root): infra + migrations + seed, serves on :3000
npm run dev          # or docker compose up -d && npm run prisma:migrate && npm run seed

# 2. Frontend (this directory), serves on :5173
npm run dev
```

Open http://localhost:5173 — sign in with the seeded student:
`alice.santos@student.portal.test` / `Password123!`.

No Docker on the machine? Boot embedded Postgres + Redis, migrate and seed with
`npx tsx ../scripts/dev-run.ts` (repo root; writes `.dev-runtime.json`, keeps serving).
Re-baseline test data between runs with `scripts/dev-reset.ts` + `prisma/seed.ts`.

`API_ORIGIN` (`.env.local`, default `http://localhost:3000`) controls the Next.js rewrite of
`/api/v1/*` to the backend, so the browser only ever talks to the Next server (no CORS).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server on port 5173 (Turbopack) |
| `npm run build` / `npm start` | Production build / serve on 5173 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (next config) |
| `npm run test` | Vitest (pure-logic suites in `src/tests/`) |
| `npm run gen:api` | Regenerates `src/lib/api/schema.d.ts` from `../openapi.json` |

Run `npm run gen:api` after any backend contract change, then `npm run typecheck`.

## Architecture

```
src/
  app/
    sign-in/            email + password, inline MFA step
    (portal)/           guarded shell: header nav, record rail, screens
      page.tsx          home (term desk, today's classes)
      enroll/           section browser, week grid, batch reserve, waitlist, drops
      schedule/         read-only week + meeting list
      grades/           GWA head + full ledger (incl. superseded versions)
      assessment/       immutable fee breakdown, cashier note
      documents/        request desk + status list
      documents/[id]/   timeline, download (clearance-gated for official), verify link
      holds/            active + lifted holds
      account/          profile, TOTP setup, session revocation
    session/            Next route handlers: login | mfa | refresh | logout
  components/           ui primitives, ledger table, shell, week grid
  lib/api/              typed client (openapi-fetch), endpoints, errors, idempotency
  lib/auth/             access-token store, single-flight refresh, auth + step-up context
  lib/hooks/            idempotent action, current term, clock
  lib/format.ts         term/time/unit/peso/GWA formatting
  lib/grid.ts           pure week-grid geometry + conflict detection
  tests/                vitest suites for the pure logic above
```

**Token custody.** The access token lives in memory only (`lib/auth/session-store.ts`). The
refresh token lives in an httpOnly cookie (`sp_rt`, path `/session`) set by the four route
handlers under `app/session/`. The backend revokes the whole token family on a reused refresh
token, so refresh is strictly single-flight on both the server (`createKeyedSingleFlight` per
token value) and the client (`refresh-client.ts`); the API client retries a 401 exactly once
with a cloned request.

**Idempotent writes.** `reserve` and document `request` require an `idempotency-key`. The
`useIdempotentAction` hook mints one per intent, keeps it across failures (safe retry), and
resets it after success (next click is a new intent).

**Week grid.** `lib/grid.ts` maps schedule minutes to 30-minute rows (07:00–20:00, Mon–Fri);
the grid renders enrolled (solid), candidate (signal), waitlisted (hatch), and conflict
(stamp outline + one pulse) states, with arrow-key navigation and a day-grouped agenda below
`lg`. Conflicts are computed client-side from the enrollment payload only as a preview — the
server remains the authority (capacity, schedule overlap, prerequisite DAG).

## Verified end-to-end

`scripts/dev-walkthrough.ps1` (repo root) drives the whole student journey through the :5173
origin — session route handlers, rewrite proxy, real backend: session custody, all screens,
reserve idempotency, prerequisite blocks, drop/re-reserve, waitlist rejection, COR and
CERT_GRADES cycles (PDF download + public verify), the registrar-only TOR gate, TOTP
enrollment and step-up elevation, hold-gated official downloads (BSL-007), refresh reuse
revocation, and MFA-required re-login. 84/0 checks green;
`scripts/dev-parallel-refresh.mjs` proves concurrent refreshes share one rotation without
family revocation.

## Conventions

- Next 16 breaking changes apply — read `node_modules/next/dist/docs/` before touching new
  app-router features. Route types come from `next typegen`.
- All money/units flows use `figure` (tabular numerals); status is never color-only
  (mark shape + text always present).
- `src/lib/api/schema.d.ts` is generated — never edit it by hand.
