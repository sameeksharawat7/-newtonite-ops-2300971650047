import { describe, it, expect, beforeAll } from 'vitest';
import { setupTeam, as, createItem } from './helpers.js';

let t;
beforeAll(async () => { t = await setupTeam(); });
const transition = (u, id, to, version) => as(u).post(`/api/items/${id}/transition`, { to, version });

describe('workflow rules (server enforced)', () => {
  it('rejects invalid jumps such as open -> closed and open -> resolved', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    const r = await transition(t.users.lead, item.id, 'closed', 1);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_TRANSITION');
    expect((await transition(t.users.admin, item.id, 'resolved', 1)).status).toBe(409);
  });

  it('full happy path with an approval step only another lead/admin can pass', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    await as(t.users.m1).post(`/api/items/${item.id}/claim`);                       // v2 in_progress
    const submit = await transition(t.users.m1, item.id, 'awaiting_approval', 2);   // v3
    expect(submit.status).toBe(200);

    expect((await transition(t.users.m1, item.id, 'resolved', 3)).status).toBe(403);   // assignee cannot self-approve
    expect((await transition(t.users.m2, item.id, 'resolved', 3)).status).toBe(403);   // plain member cannot approve
    expect((await transition(t.users.viewer, item.id, 'resolved', 3)).status).toBe(403);
    const ok = await transition(t.users.lead, item.id, 'resolved', 3);                  // v4
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('resolved');
    expect((await transition(t.users.m1, item.id, 'closed', 4)).status).toBe(403);       // closing needs lead
    expect((await transition(t.users.lead, item.id, 'closed', 4)).status).toBe(200);

    const edit = await as(t.users.lead).patch(`/api/items/${item.id}`, { version: 5, title: 'nope' });
    expect(edit.status).toBe(409);                                                       // closed is terminal
  });

  it('a lead who is the assignee cannot approve their own work (four-eyes)', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    await as(t.users.lead).post(`/api/items/${item.id}/claim`);
    await transition(t.users.lead, item.id, 'awaiting_approval', 2);
    const r = await transition(t.users.lead, item.id, 'resolved', 3);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_APPROVAL');
    expect((await transition(t.users.lead2, item.id, 'resolved', 3)).status).toBe(200);
  });

  it('a transition based on a stale version is rejected with the latest item', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    await as(t.users.m1).post(`/api/items/${item.id}/claim`);
    const r = await transition(t.users.m1, item.id, 'awaiting_approval', 1); // client still thinks v1
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('VERSION_CONFLICT');
    expect(r.body.error.current.status).toBe('in_progress');
  });

  it('releasing an item clears the owner and returns it to open', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    await as(t.users.m1).post(`/api/items/${item.id}/claim`);
    const r = await transition(t.users.m1, item.id, 'open', 2);
    expect(r.body.status).toBe('open');
    expect(r.body.assignee_id).toBeNull();
  });
});

describe('resource-level authorization', () => {
  it('a user from another team gets 404 on read and write, and never sees the item in lists', async () => {
    const item = await createItem(t.users.m1, t.teamId, { title: 'secret-zebra-item' });
    const o = t.users.outsider;
    expect((await as(o).get(`/api/items/${item.id}`)).status).toBe(404);
    expect((await as(o).get(`/api/items/${item.id}/activity`)).status).toBe(404);
    expect((await as(o).patch(`/api/items/${item.id}`, { version: 1, title: 'x' })).status).toBe(404);
    expect((await as(o).post(`/api/items/${item.id}/claim`)).status).toBe(404);
    expect((await as(o).post(`/api/items/${item.id}/comments`, { body: 'hi' })).status).toBe(404);
    expect((await as(o).post('/api/items', { team_id: t.teamId, title: 'x', type: 'task' })).status).toBe(404);
    const list = await as(o).get('/api/items?q=secret-zebra-item');
    expect(list.body.items).toHaveLength(0);
  });

  it('a viewer can read but not write (403)', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    const v = t.users.viewer;
    expect((await as(v).get(`/api/items/${item.id}`)).status).toBe(200);
    expect((await as(v).post('/api/items', { team_id: t.teamId, title: 'x', type: 'task' })).status).toBe(403);
    expect((await as(v).post(`/api/items/${item.id}/claim`)).status).toBe(403);
    expect((await as(v).post(`/api/items/${item.id}/comments`, { body: 'hi' })).status).toBe(403);
  });

  it('a member cannot edit an item assigned to someone else, but a lead can; only leads can assign', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    await as(t.users.m1).post(`/api/items/${item.id}/claim`);
    expect((await as(t.users.m2).patch(`/api/items/${item.id}`, { version: 2, title: 'hijack' })).status).toBe(403);
    expect((await as(t.users.m2).post(`/api/items/${item.id}/assign`, { assignee_id: t.users.m2.id, version: 2 })).status).toBe(403);
    expect((await as(t.users.lead).patch(`/api/items/${item.id}`, { version: 2, title: 'lead edit' })).status).toBe(200);
    const a = await as(t.users.lead).post(`/api/items/${item.id}/assign`, { assignee_id: t.users.m2.id, version: 3 });
    expect(a.status).toBe(200);
    expect(a.body.assignee_id).toBe(t.users.m2.id);
  });

  it('cannot assign to a user who is not in the item team', async () => {
    const item = await createItem(t.users.m1, t.teamId);
    const a = await as(t.users.lead).post(`/api/items/${item.id}/assign`, { assignee_id: t.users.outsider.id, version: 1 });
    expect(a.status).toBe(400);
  });

  it('rejects requests without a valid token', async () => {
    const { default: request } = await import('supertest');
    const { app } = await import('./helpers.js');
    expect((await request(app).get('/api/items')).status).toBe(401);
    expect((await request(app).get('/api/items').set('Authorization', 'Bearer junk')).status).toBe(401);
  });
});
