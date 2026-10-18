import { describe, it, expect, beforeAll } from 'vitest';
import { setupTeam, as, createItem } from './helpers.js';

let t;
beforeAll(async () => { t = await setupTeam(); });

describe('listing, search and pagination', () => {
  it('cursor pagination walks every item exactly once, newest first', async () => {
    for (let i = 0; i < 25; i++) await createItem(t.users.m1, t.teamId, { title: `Paged item ${i}` });
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const r = await as(t.users.m1).get(`/api/items?team_id=${t.teamId}&limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((i) => i.id));
      cursor = r.body.next_cursor; pages++;
    } while (cursor);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(seen.length);          // no duplicates
    expect(seen.length).toBeGreaterThanOrEqual(25);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);  // stable order
  });

  it('full-text search and filters run on the server', async () => {
    await createItem(t.users.m1, t.teamId, { title: 'Gateway timeout xylophone', priority: 'urgent' });
    const r = await as(t.users.m1).get('/api/items?q=xylophone');
    expect(r.body.items).toHaveLength(1);
    expect((await as(t.users.m1).get('/api/items?q=xylophone&priority=low')).body.items).toHaveLength(0);
    expect((await as(t.users.m1).get('/api/items?status=bogus')).status).toBe(400);
    expect((await as(t.users.m1).get('/api/items?cursor=garbage')).status).toBe(400);
  });

  it('dashboard views react to claims and approvals', async () => {
    const item = await createItem(t.users.m1, t.teamId, { title: 'Urgent unowned unicorn', priority: 'urgent' });
    const urgent = async () => (await as(t.users.m2).get('/api/items?view=unassigned_urgent&q=unicorn')).body.items.map((i) => i.id);
    expect(await urgent()).toContain(item.id);
    await as(t.users.m2).post(`/api/items/${item.id}/claim`);
    expect(await urgent()).not.toContain(item.id);
    const mine = (await as(t.users.m2).get('/api/items?view=assigned_to_me&q=unicorn')).body.items.map((i) => i.id);
    expect(mine).toContain(item.id);

    await as(t.users.m2).post(`/api/items/${item.id}/transition`, { to: 'awaiting_approval', version: 2 });
    const lead = (await as(t.users.lead).get('/api/items?view=awaiting_my_approval&q=unicorn')).body.items.map((i) => i.id);
    expect(lead).toContain(item.id);
    const member = (await as(t.users.m1).get('/api/items?view=awaiting_my_approval&q=unicorn')).body.items;
    expect(member).toHaveLength(0); // plain members have nothing to approve
    const counts = (await as(t.users.lead).get('/api/dashboard')).body;
    expect(counts.awaiting_my_approval).toBeGreaterThanOrEqual(1);
  });
});
