# Engineering Decisions

Each decision: **context → options → choice → trade-off**.

## 1. PostgreSQL as the single source of truth (and raw SQL, no ORM)
**Context.** The brief is about correctness under concurrency; tens of thousands of items and an ever-growing history.
**Options.** MongoDB (matches the MERN habit), Postgres + ORM, Postgres + hand-written SQL.
**Choice.** Postgres with `pg` and explicit SQL. Atomic conditional `UPDATE … WHERE`, transactions, partial indexes, `CHECK` constraints, `FOR UPDATE SKIP LOCKED` and full-text search (`tsvector` + GIN) are all things I need and they are first-class in Postgres. Writing the SQL by hand keeps the concurrency logic visible (the `WHERE assignee_id IS NULL` *is* the lock) instead of hidden behind an ORM.
**Data model.** `work_items` (with `version`), `memberships(user, team, role)`, append-only `activity_events` (also stores comments), `idempotency_keys`, `jobs` (outbox), `notifications`. Invariants live in the DB too: in-progress work must have an owner (`CHECK`), history can never be edited (trigger), statuses/priorities are `CHECK`ed text rather than ENUMs so adding a status is a one-line change.
**Trade-off.** More SQL to write/maintain, no automatic migrations diffing, and a relational schema is less flexible than documents. Accepted: the data is naturally relational and correctness matters more than speed of prototyping.

## 2. Concurrency: atomic claim + optimistic locking + idempotency keys (three different tools)
**Context.** Two people claim the same item; someone edits a stale copy; a user double-clicks or retries after a timeout.
**Choice.**
- *Claim* → one statement: `UPDATE … SET assignee=me WHERE id=? AND assignee_id IS NULL AND status='open'`. 0 rows → 409 with the current owner. Claiming something you already own is a 200 no-op so double-clicks are harmless.
- *Edits, assignment, transitions* → `version` column. Client sends the version it saw; `UPDATE … WHERE version=?` then `version+1`. Mismatch → 409 with the latest item so the UI can reconcile. Comments deliberately do **not** touch `version`, so commenting never causes edit conflicts.
- *Retries* → `Idempotency-Key` header on every mutation. The key row is inserted in the **same transaction** as the work; the unique index makes a parallel duplicate wait for the first to commit and then replay the stored response. A rolled-back (409) request does not store its key, so a legitimate retry still works. Same key + different body → 422.
**Why not row locks (`SELECT … FOR UPDATE`)?** They'd serialize readers/writers and hold locks across user think-time or network hops; a conditional update gives the same guarantee in one round trip without lock management.
**Trade-off.** Users sometimes see a conflict message instead of a silent last-write-wins, which is the point; field-level merging is not attempted (see limitations). Idempotency rows grow forever without a cleanup job.

## 3. Authorization: one function, per-team roles, resource-level rules, 404 vs 403
**Context.** Users belong to several teams with different roles; the UI must not be the only guard.
**Choice.** `permissions.js: check(user, action, item)` is the only place rules live; every service function calls `authorize()`. Roles are per team (`viewer < member < lead < admin`). Resource-level rules on top of the role matrix: members may edit/move only items that are unassigned or theirs; only leads/admins assign, approve, close; the **assignee can never approve their own work** (four-eyes). Memberships are loaded from the DB on every request, so role changes apply immediately. All list queries are scoped by `team_id = ANY(user's teams)` in SQL. Non-members get **404** (existence is not leaked); members with too low a role get **403**. The API also returns a `permissions` object per item computed by the same function, so the UI shows exactly the buttons the server would allow, with no duplicated logic.
**Trade-off.** One extra query per request for memberships (cheap, indexed); a cache would be the next step at scale. No per-item ACLs or team-management UI (seed data only).

## 4. Workflow, history and async work live in the same transaction
**Context.** "Important actions should not silently disappear" and secondary work (notifications) may fail or run twice.
**Choice.** The state machine is a single map in `workflow.js` (`open` →claim→ `in_progress` → `awaiting_approval` → `resolved` → `closed`, plus release/reject/reopen); invalid jumps return 409 `INVALID_TRANSITION`. Every change writes its `activity_events` row **and** (where relevant) a `jobs` row in the **same transaction** — history cannot disagree with the item, and a job exists if and only if the change committed (transactional outbox). A worker claims jobs with `FOR UPDATE SKIP LOCKED`, retries with exponential backoff, stops at `max_attempts` (status `failed`), and reclaims jobs whose lease expired after a crash. Delivery is at-least-once, so handlers are idempotent: `notifications.dedupe_key` is `UNIQUE` and inserts use `ON CONFLICT DO NOTHING`.
**Synchronous vs async.** Synchronous: anything that decides correctness (claim, transition, permission check, history). Asynchronous: notifications.
**Trade-off.** Polling the jobs table adds ~1 query/second per worker and latency of up to a second; a broker (SQS/Rabbit/BullMQ) scales better but adds infrastructure and loses the "same transaction" guarantee unless I still keep the outbox. Notifications are in-app rows only (no email).

## 5. Scale-aware reads: keyset pagination, purpose-built indexes, polling instead of websockets
**Context.** Tens of thousands of active items, growing history, hundreds–thousands of concurrent users; the browser must never load everything.
**Choice.** All filtering, search and paging happen in SQL. Lists use **keyset pagination** on `(updated_at, id)` with an opaque cursor (stable under inserts, constant cost at any depth, unlike `OFFSET`). Partial indexes match the dashboard views exactly (unassigned-urgent, awaiting-approval, assignee) — the "assigned to me" query runs in ~0.1 ms on 5k rows via index scan. Search uses a stored generated `tsvector` with a GIN index. Activity is paged by `id`. The UI uses TanStack Query (cache, background refetch every 10–20 s, optimistic claim with rollback on server rejection). I chose **polling over websockets**: far simpler to operate and good enough for "see what changed"; conflicts are caught by versions anyway.
**Trade-off.** Updates can be up to ~20 s late; `updated_at` ordering means an item that is edited while the user is paging can appear on an earlier page; full-text search matches whole words (stemmed), not prefixes.

---

## What I intentionally did not build
Email delivery, attachments, SSO, websockets, team/role administration UI, SLA timers, rich text, rate limiting.

## Known limitations
- **Auth:** simple email+password with a 12 h JWT in `localStorage` (XSS-exposed; production would use httpOnly cookies, refresh tokens, rate limiting/lockout, and SSO). Demo passwords are public.
- **Conflict handling** is whole-item: if two people edit *different* fields of the same item, the second still gets a conflict and must reload (no field-level merge).
- **Idempotency keys and finished/failed jobs are never purged**; `activity_events` is a single growing table (would partition by time / archive at 10×).
- **Dashboard counts** run 4 indexed count queries per refresh; at much larger scale they should be cached or maintained incrementally.
- **Search** is stemmed full-text only (no typo tolerance/prefix); a dedicated engine (OpenSearch) would come first at 10×.
- **Polling** instead of push; no tab-to-tab live updates inside the 10–20 s window.
- **Notifications** are in-app only; failed jobs are visible only in the `jobs` table (no admin UI or alerting).
- **Tests** run against a real Postgres but there are no browser/UI tests (the optimistic-rollback path is verified manually). The Docker image was not run in the authoring environment; run `docker compose up --build` from a fresh clone before submitting.

## What I would do with another week
1. Field-level merge on conflicts + "someone is editing" presence.
2. Team/role admin UI and an audit view for permission changes.
3. WebSocket/SSE push (Postgres `LISTEN/NOTIFY` → API → browser) replacing polling.
4. Job dashboard (failed/dead-letter, manual retry), alerting, metrics.
5. Retention: purge idempotency keys, partition `activity_events` by month.
6. Playwright tests for optimistic UI rollback and conflict banners; load test (k6) against 50k items.
7. SLA/due-date escalation jobs (scheduled outbox entries) and email delivery.
