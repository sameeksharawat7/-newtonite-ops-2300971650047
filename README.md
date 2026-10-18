# Ops Desk — Newtonite "Operations Under Pressure"

An internal web app where teams create, claim, approve and resolve operational work items (incidents, customer issues, payments, compliance, tasks) with a full audit trail.
It is built around **correctness under concurrency**: atomic claims, optimistic locking, idempotent requests, a server-enforced workflow, per-team authorization and a transactional outbox for background work.

**Stack:** Node 22 + Express 5 · PostgreSQL 16 (raw SQL via `pg`) · React 18 + Vite + TanStack Query · Vitest + Supertest · Docker Compose.

## Run it (one command)

Prerequisite: Docker Desktop.

```bash
docker compose up --build
# open http://localhost:3000
```

This starts Postgres, the API (applies migrations, seeds 4 teams / 10 users / 5,000 items, serves the UI) and the background worker.

### Demo logins — password for all: `password123`

| Email | Role per team |
|---|---|
| `admin@demo.test` | admin in all 4 teams |
| `lead1@demo.test` | lead in Engineering, Payments |
| `lead2@demo.test` | lead in Customer Support, Compliance |
| `member1@demo.test` | member in Engineering, Customer Support |
| `member2@demo.test` | member in Engineering only |
| `member3@demo.test` | member in Payments |
| `member4@demo.test` | member in Payments, Compliance |
| `member5@demo.test` | member in Customer Support |
| `member6@demo.test` | member in Compliance |
| `viewer@demo.test` | viewer (read-only) in all teams |

### 2-minute demo script
1. Sign in as `member1`, open **Unassigned urgent**, open an Engineering item, **Claim** it (optimistic UI).
2. In a second browser/incognito sign in as `member2`, open the same item *before* member1 claims → the loser gets "Already claimed by …" and the UI rolls back.
3. As the owner click **Submit for approval**. Sign in as `lead1` → **Awaiting my approval** → approve. Try approving as the assignee (blocked: four-eyes rule).
4. Open the same item in two tabs, edit the title in both, save both → the second shows the **version conflict** banner and keeps your draft.
5. Bell icon: notifications were created asynchronously by the worker.

## Run without Docker (development)

```bash
# 1. Postgres running locally with databases `newtonite` and `newtonite_test`
cd server && npm install
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/newtonite
npm run db:setup           # migrate + seed
RUN_WORKER=true npm start  # API on :3000 with the worker in-process

# 2. in another terminal
cd client && npm install && npm run dev   # UI on http://localhost:5173 (proxies /api)
```

## Tests

```bash
# needs Postgres reachable at TEST_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/newtonite_test)
# `docker compose up db -d` provides it; create the DB once:
docker compose exec db psql -U postgres -c "create database newtonite_test"
cd server && npm test      # 28 tests, ~4 s, resets the test DB each run
```

What is tested (the behaviours that would be dangerous if wrong): concurrent claim (exactly one winner), stale-version updates, idempotent/parallel duplicate requests, invalid workflow jumps, approval rights + four-eyes rule, cross-team isolation (404), viewer restrictions, history-written-with-change, append-only history, outbox exactly-once effect, retry → failed, crashed-worker lease recovery, parallel workers (SKIP LOCKED), pagination and dashboard views.

## Architecture

```mermaid
flowchart LR
  B[Browser<br/>React + TanStack Query] -->|REST + JWT<br/>Idempotency-Key| A[API<br/>Express]
  A -->|one transaction:<br/>item + activity_event + job| P[(PostgreSQL)]
  W[Worker<br/>SKIP LOCKED poller] -->|claim jobs, write notifications| P
  B -.->|polling 10-20s| A
```

More detail (file map, request flow, interview prep): `docs/WALKTHROUGH.md`. Design decisions and trade-offs: `ENGINEERING_DECISIONS.md`.

## API summary

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` | email + password → JWT |
| `GET /api/me`, `GET /api/dashboard` | profile + roles, counts for the 3 attention views |
| `GET /api/items?view&q&status&priority&type&team_id&assignee&overdue&cursor&limit` | server-side filter / search / keyset pagination |
| `POST /api/items` | create (idempotent) |
| `GET /api/items/:id` | detail incl. server-computed `permissions` |
| `PATCH /api/items/:id` | edit, requires `version` (optimistic lock) |
| `POST /api/items/:id/claim` | atomic claim |
| `POST /api/items/:id/assign` | lead/admin reassign |
| `POST /api/items/:id/transition` | workflow move, requires `version` |
| `POST /api/items/:id/comments`, `GET /api/items/:id/activity` | collaboration + history |
| `GET /api/notifications`, `POST /api/notifications/read` | async-generated notifications |

Errors are always `{ "error": { "code", "message", ...extra } }`; 409 conflicts include `current` (latest item) so the client can reconcile.

## Known limitations
See the end of `ENGINEERING_DECISIONS.md`.
