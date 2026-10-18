-- Identity & access ---------------------------------------------------------
CREATE TABLE users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE teams (
  id   bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);
-- A user may belong to many teams with a different role in each.
CREATE TABLE memberships (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id bigint NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role    text   NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX memberships_team_idx ON memberships (team_id);

-- Work items ----------------------------------------------------------------
-- Text + CHECK instead of ENUM types: adding a status later is a one-line
-- constraint change instead of ALTER TYPE.
CREATE TABLE work_items (
  id          bigserial PRIMARY KEY,
  team_id     bigint NOT NULL REFERENCES teams(id),
  title       text   NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text   NOT NULL DEFAULT '',
  type        text   NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority    text   NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status      text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  assignee_id bigint REFERENCES users(id),
  created_by  bigint NOT NULL REFERENCES users(id),
  due_date    date,
  version     integer NOT NULL DEFAULT 1,           -- optimistic-lock counter
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (
                to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))
              ) STORED,
  -- Invariant enforced by the database itself, even if app code has a bug:
  CONSTRAINT active_work_has_owner CHECK (status NOT IN ('in_progress','awaiting_approval') OR assignee_id IS NOT NULL)
);
-- Indexes chosen for the dashboard queries (see docs/WALKTHROUGH.md)
CREATE INDEX wi_team_status_idx   ON work_items (team_id, status, updated_at DESC, id DESC);
CREATE INDEX wi_assignee_idx      ON work_items (assignee_id, updated_at DESC, id DESC) WHERE assignee_id IS NOT NULL;
CREATE INDEX wi_unassigned_urgent ON work_items (team_id, updated_at DESC, id DESC) WHERE assignee_id IS NULL AND status = 'open' AND priority = 'urgent';
CREATE INDEX wi_awaiting_approval ON work_items (team_id, updated_at DESC, id DESC) WHERE status = 'awaiting_approval';
CREATE INDEX wi_due_idx           ON work_items (due_date) WHERE status NOT IN ('resolved','closed');
CREATE INDEX wi_updated_idx       ON work_items (updated_at DESC, id DESC);
CREATE INDEX wi_search_idx        ON work_items USING GIN (search);

-- Append-only history (also holds comments) -----------------------------------
CREATE TABLE activity_events (
  id         bigserial PRIMARY KEY,
  item_id    bigint NOT NULL REFERENCES work_items(id),
  actor_id   bigint REFERENCES users(id),
  type       text   NOT NULL,
  data       jsonb  NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_item_idx ON activity_events (item_id, id DESC);
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'activity_events is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER activity_append_only BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Idempotency ---------------------------------------------------------------
CREATE TABLE idempotency_keys (
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             text   NOT NULL,
  request_hash    text   NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Transactional outbox / job queue --------------------------------------------
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text   NOT NULL,
  payload      jsonb  NOT NULL DEFAULT '{}',
  status       text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error   text,
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs (run_at, id) WHERE status IN ('pending','processing');

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    bigint REFERENCES work_items(id),
  kind       text   NOT NULL,
  message    text   NOT NULL,
  dedupe_key text   NOT NULL UNIQUE,       -- makes the job handler idempotent
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
