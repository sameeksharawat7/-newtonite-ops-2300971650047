import { pool, tx } from './db.js';
import { config } from './config.js';

/** Called INSIDE the business transaction => the job exists iff the change committed (transactional outbox). */
export async function enqueue(client, type, payload, dedupeKey = null, maxAttempts = 5) {
  await client.query(
    `INSERT INTO jobs (type, payload, dedupe_key, max_attempts) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [type, payload, dedupeKey, maxAttempts],
  );
}

// Handlers MUST be idempotent: the queue is at-least-once.
// Idempotency comes from notifications.dedupe_key UNIQUE + ON CONFLICT DO NOTHING.
const insertNotification = (client, { userId, itemId, kind, message, key }) =>
  client.query(
    `INSERT INTO notifications (user_id, item_id, kind, message, dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [userId, itemId, kind, message, key],
  );

export const defaultHandlers = {
  async notify_user(client, p) {
    await insertNotification(client, p);
  },
  async notify_approvers(client, p) {
    const { rows } = await client.query(
      `SELECT w.title, w.assignee_id, m.user_id FROM work_items w
         JOIN memberships m ON m.team_id = w.team_id AND m.role IN ('lead','admin')
        WHERE w.id = $1`, [p.itemId]);
    for (const r of rows) {
      if (r.user_id === r.assignee_id) continue; // four-eyes: assignee cannot approve
      await insertNotification(client, {
        userId: r.user_id, itemId: p.itemId, kind: 'approval_requested',
        message: `Awaiting your approval: ${r.title}`, key: `approvers:${p.itemId}:${p.version}:${r.user_id}`,
      });
    }
  },
};

/** Claim a batch with FOR UPDATE SKIP LOCKED so many workers never take the same job. */
export async function processBatch({ handlers = defaultHandlers, batch = 10 } = {}) {
  const types = Object.keys(handlers);
  const { rows: jobs } = await pool.query(
    `UPDATE jobs SET status='processing', attempts = attempts + 1, locked_until = now() + interval '60 seconds'
      WHERE id IN (
        SELECT id FROM jobs
         WHERE type = ANY($2) AND run_at <= now()
           AND (status = 'pending' OR (status = 'processing' AND locked_until < now()))  -- crashed worker => reclaim
         ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [batch, types]);

  let done = 0, failed = 0;
  for (const job of jobs) {
    try {
      await tx(async (c) => {
        await handlers[job.type](c, job.payload);
        await c.query(`UPDATE jobs SET status='done', locked_until=NULL, last_error=NULL WHERE id=$1`, [job.id]);
      });
      done++;
    } catch (e) {
      const dead = job.attempts >= job.max_attempts;
      await pool.query(
        `UPDATE jobs SET status = $2, locked_until = NULL, last_error = $3,
                run_at = now() + make_interval(secs => $4::float8 * power(2, $5 - 1))
          WHERE id = $1`,
        [job.id, dead ? 'failed' : 'pending', String(e.message).slice(0, 500), config.jobBackoffBase, job.attempts]);
      failed++;
    }
  }
  return { claimed: jobs.length, done, failed };
}

export function startWorker({ intervalMs = 1000, handlers = defaultHandlers } = {}) {
  let stopped = false;
  (async function loop() {
    while (!stopped) {
      try {
        const r = await processBatch({ handlers });
        if (r.claimed === 0) await new Promise((res) => setTimeout(res, intervalMs));
      } catch (e) {
        console.error('worker error', e.message);
        await new Promise((res) => setTimeout(res, intervalMs));
      }
    }
  })();
  return () => { stopped = true; };
}
