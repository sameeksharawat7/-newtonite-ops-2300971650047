import { describe, it, expect, beforeAll } from 'vitest';
import { setupTeam, as, createItem, uuid, pool } from './helpers.js';

let t;
beforeAll(async () => { t = await setupTeam(); });
const events = async (id, type) => (await pool.query('SELECT * FROM activity_events WHERE item_id=$1 AND type=$2', [id, type])).rows;

describe('concurrent claim', () => {
  it('only ONE of many simultaneous claimers wins; the rest get 409', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    const racers = [t.users.m1, t.users.m2, t.users.m3, t.users.m4, t.users.m5, t.users.lead, t.users.admin];
    const results = await Promise.all(racers.map((u) => as(u).post(`/api/items/${item.id}/claim`)));
    const wins = results.filter((r) => r.status === 200);
    const losses = results.filter((r) => r.status === 409);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(racers.length - 1);
    expect(losses[0].body.error.code).toBe('ALREADY_CLAIMED');

    const { rows: [row] } = await pool.query('SELECT assignee_id, status, version FROM work_items WHERE id=$1', [item.id]);
    expect(row.assignee_id).toBe(wins[0].body.assignee_id);
    expect(row.status).toBe('in_progress');
    expect(row.version).toBe(2);                        // bumped exactly once
    expect(await events(item.id, 'claimed')).toHaveLength(1); // history agrees with the item
  });

  it('claiming twice as the same user (double click) is a harmless no-op', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    const [a, b] = await Promise.all([as(t.users.m2).post(`/api/items/${item.id}/claim`), as(t.users.m2).post(`/api/items/${item.id}/claim`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await events(item.id, 'claimed')).toHaveLength(1);
  });
});

describe('stale updates (optimistic locking)', () => {
  it('rejects an edit based on an old version and leaves data unchanged', async () => {
    const item = await createItem(t.users.m1, t.teamId, { title: 'Original' });
    const a = await as(t.users.lead).patch(`/api/items/${item.id}`, { version: 1, title: 'Lead edit' });
    expect(a.status).toBe(200);
    expect(a.body.version).toBe(2);

    const b = await as(t.users.lead2).patch(`/api/items/${item.id}`, { version: 1, title: 'Stale edit' });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('VERSION_CONFLICT');
    expect(b.body.error.current.title).toBe('Lead edit');   // client gets the latest to reconcile
    expect(b.body.error.current.version).toBe(2);

    const { rows: [row] } = await pool.query('SELECT title, version FROM work_items WHERE id=$1', [item.id]);
    expect(row).toEqual({ title: 'Lead edit', version: 2 });
  });

  it('two simultaneous edits with the same version: exactly one wins', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    const rs = await Promise.all([
      as(t.users.lead).patch(`/api/items/${item.id}`, { version: 1, title: 'A' }),
      as(t.users.lead2).patch(`/api/items/${item.id}`, { version: 1, title: 'B' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('idempotency keys', () => {
  it('same key twice => one item, same response replayed', async () => {
    const key = uuid();
    const body = { team_id: t.teamId, title: 'Idem item ' + key, type: 'task' };
    const first = await as(t.users.m1).post('/api/items', body, key);
    const second = await as(t.users.m1).post('/api/items', body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replay']).toBe('true');
    const { rows } = await pool.query('SELECT id FROM work_items WHERE title=$1', [body.title]);
    expect(rows).toHaveLength(1);
  });

  it('five PARALLEL requests with one key still create exactly one item', async () => {
    const key = uuid();
    const body = { team_id: t.teamId, title: 'Parallel idem ' + key, type: 'task' };
    const rs = await Promise.all(Array.from({ length: 5 }, () => as(t.users.m1).post('/api/items', body, key)));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    const { rows } = await pool.query('SELECT id FROM work_items WHERE title=$1', [body.title]);
    expect(rows).toHaveLength(1);
  });

  it('reusing a key with a DIFFERENT payload is rejected (422)', async () => {
    const key = uuid();
    await as(t.users.m1).post('/api/items', { team_id: t.teamId, title: 'one', type: 'task' }, key);
    const r = await as(t.users.m1).post('/api/items', { team_id: t.teamId, title: 'two', type: 'task' }, key);
    expect(r.status).toBe(422);
  });

  it('a failed request does not poison its key (retry can still succeed)', async () => {
    const key = uuid();
    const item = await createItem(t.users.m1, t.teamId);
    const bad = await as(t.users.m1).patch(`/api/items/${item.id}`, { version: 99, title: 'x' }, key);
    expect(bad.status).toBe(409);
    const { rows } = await pool.query('SELECT 1 FROM idempotency_keys WHERE key=$1', [key]);
    expect(rows).toHaveLength(0);
  });
});

describe('history is atomic with the change', () => {
  it('every change writes exactly one event and the append-only trigger blocks tampering', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    await as(t.users.m1).post(`/api/items/${item.id}/claim`);
    await as(t.users.m1).patch(`/api/items/${item.id}`, { version: 2, priority: 'urgent' });
    const { rows } = await pool.query('SELECT type FROM activity_events WHERE item_id=$1 ORDER BY id', [item.id]);
    expect(rows.map((r) => r.type)).toEqual(['created', 'claimed', 'priority_changed']);
    await expect(pool.query('UPDATE activity_events SET type=$1 WHERE item_id=$2', ['x', item.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM activity_events WHERE item_id=$1', [item.id])).rejects.toThrow(/append-only/);
  });
});
