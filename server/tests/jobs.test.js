import { describe, it, expect, beforeAll } from 'vitest';
import { setupTeam, as, createItem, pool } from './helpers.js';
import { processBatch, enqueue } from '../src/jobs.js';

let t;
beforeAll(async () => { t = await setupTeam(); });

describe('transactional outbox + worker', () => {
  it('the job is written with the change, and processing it TWICE yields ONE notification', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    const a = await as(t.users.lead).post(`/api/items/${item.id}/assign`, { assignee_id: t.users.m2.id, version: 1 });
    expect(a.status).toBe(200);

    const q = () => pool.query(`SELECT * FROM jobs WHERE type='notify_user' AND dedupe_key=$1`, [`assign:${item.id}:2`]);
    expect((await q()).rows).toHaveLength(1);

    await processBatch();
    const notes = () => pool.query('SELECT * FROM notifications WHERE item_id=$1 AND user_id=$2', [item.id, t.users.m2.id]);
    expect((await notes()).rows).toHaveLength(1);

    // simulate "worker crashed after doing the work but before marking done": run the same job again
    await pool.query(`UPDATE jobs SET status='pending', run_at=now() WHERE dedupe_key=$1`, [`assign:${item.id}:2`]);
    await processBatch();
    expect((await notes()).rows).toHaveLength(1);
    expect((await q()).rows[0].status).toBe('done');
  });

  it('a rolled-back change leaves NO job behind', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    // stale version => 409 => transaction rolled back => no job
    await as(t.users.lead).post(`/api/items/${item.id}/assign`, { assignee_id: t.users.m2.id, version: 42 });
    const { rows } = await pool.query(`SELECT 1 FROM jobs WHERE dedupe_key LIKE $1`, [`assign:${item.id}:%`]);
    expect(rows).toHaveLength(0);
  });

  it('requesting approval fans out to leads/admins except the assignee', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    await as(t.users.lead).post(`/api/items/${item.id}/claim`);
    await as(t.users.lead).post(`/api/items/${item.id}/transition`, { to: 'awaiting_approval', version: 2 });
    await processBatch();
    const { rows } = await pool.query('SELECT user_id FROM notifications WHERE item_id=$1 AND kind=$2', [item.id, 'approval_requested']);
    const ids = rows.map((r) => r.user_id).sort();
    expect(ids).toEqual([t.users.lead2.id, t.users.admin.id].sort());
  });

  it('failing jobs retry with backoff, then are marked failed after max attempts', async () => {
    await enqueue(pool, 'boom', { x: 1 }, 'boom-1', 3);
    const handlers = { boom: async () => { throw new Error('kaboom'); } };
    for (let i = 0; i < 3; i++) await processBatch({ handlers });
    const { rows: [job] } = await pool.query(`SELECT status, attempts, last_error FROM jobs WHERE dedupe_key='boom-1'`);
    expect(job).toEqual({ status: 'failed', attempts: 3, last_error: 'kaboom' });
    await processBatch({ handlers }); // failed jobs are never picked up again
    expect((await pool.query(`SELECT attempts FROM jobs WHERE dedupe_key='boom-1'`)).rows[0].attempts).toBe(3);
  });

  it('a job stuck "processing" after a worker crash is reclaimed once its lease expires', async () => {
    await enqueue(pool, 'crashy', {}, 'crashy-1');
    await pool.query(`UPDATE jobs SET status='processing', attempts=1, locked_until = now() - interval '1 minute' WHERE dedupe_key='crashy-1'`);
    let ran = 0;
    await processBatch({ handlers: { crashy: async () => { ran++; } } });
    expect(ran).toBe(1);
  });

  it('two workers running concurrently never run the same job twice (SKIP LOCKED)', async () => {
    for (let i = 0; i < 20; i++) await enqueue(pool, 'count', { i }, `count-${i}`);
    const seen = [];
    const handlers = { count: async (_c, p) => { seen.push(p.i); } };
    await Promise.all([processBatch({ handlers, batch: 20 }), processBatch({ handlers, batch: 20 })]);
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
  });
});
