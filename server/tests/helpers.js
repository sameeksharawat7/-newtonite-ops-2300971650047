import request from 'supertest';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';

export const app = createApp();
const hash = bcrypt.hashSync('pw', 4);
const uid = () => crypto.randomBytes(4).toString('hex');

/** Creates an isolated team plus one user per role (+ an outsider and a 2nd lead). Returns logged-in clients. */
export async function setupTeam() {
  const tag = uid();
  const { rows: [team] } = await pool.query('INSERT INTO teams(name) VALUES ($1) RETURNING id', [`team-${tag}`]);
  const { rows: [other] } = await pool.query('INSERT INTO teams(name) VALUES ($1) RETURNING id', [`other-${tag}`]);
  const make = async (name, role, teamId = team.id) => {
    const email = `${name}-${tag}@t.test`;
    const { rows: [u] } = await pool.query('INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id', [email, name, hash]);
    if (role) await pool.query('INSERT INTO memberships VALUES ($1,$2,$3)', [u.id, teamId, role]);
    const { body } = await request(app).post('/api/auth/login').send({ email, password: 'pw' });
    return { id: u.id, email, token: body.token, name };
  };
  const users = {
    viewer: await make('viewer', 'viewer'),
    m1: await make('m1', 'member'), m2: await make('m2', 'member'), m3: await make('m3', 'member'),
    m4: await make('m4', 'member'), m5: await make('m5', 'member'),
    lead: await make('lead', 'lead'), lead2: await make('lead2', 'lead'),
    admin: await make('admin', 'admin'),
    outsider: await make('outsider', 'member', other.id), // member of a DIFFERENT team
  };
  return { teamId: team.id, users };
}

export const as = (user) => ({
  get: (url) => request(app).get(url).set('Authorization', `Bearer ${user.token}`),
  post: (url, body, key) => { const r = request(app).post(url).set('Authorization', `Bearer ${user.token}`); if (key) r.set('Idempotency-Key', key); return r.send(body ?? {}); },
  patch: (url, body, key) => { const r = request(app).patch(url).set('Authorization', `Bearer ${user.token}`); if (key) r.set('Idempotency-Key', key); return r.send(body ?? {}); },
});

export async function createItem(user, teamId, overrides = {}) {
  const res = await as(user).post('/api/items', { team_id: teamId, title: 'Test item', type: 'task', priority: 'medium', ...overrides });
  if (res.status !== 201) throw new Error(`createItem failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
export const uuid = () => crypto.randomUUID();
export { pool };
