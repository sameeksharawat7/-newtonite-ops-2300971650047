import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError } from './errors.js';
import { mutate } from './idempotency.js';
import * as items from './items.js';

/** Load the caller and ALL their team roles on every request, so role changes apply immediately. */
async function auth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!m) throw new AppError(401, 'UNAUTHENTICATED', 'Missing token');
  let payload;
  try { payload = jwt.verify(m[1], config.jwtSecret); } catch { throw new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token'); }
  const { rows: [u] } = await pool.query('SELECT id, name, email FROM users WHERE id=$1', [payload.sub]);
  if (!u) throw new AppError(401, 'UNAUTHENTICATED', 'Unknown user');
  const { rows } = await pool.query(
    `SELECT m.team_id, t.name AS team_name, m.role FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1 ORDER BY t.name`, [u.id]);
  req.user = { ...u, memberships: rows };
  next();
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  const api = express.Router();

  api.get('/health', (req, res) => res.json({ ok: true }));

  api.post('/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') throw new AppError(400, 'VALIDATION', 'email and password required');
    const { rows: [u] } = await pool.query('SELECT id, password_hash FROM users WHERE email=$1', [email.toLowerCase().trim()]);
    // same error for unknown user / wrong password (no user enumeration)
    if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new AppError(401, 'BAD_CREDENTIALS', 'Wrong email or password');
    res.json({ token: jwt.sign({ sub: u.id }, config.jwtSecret, { expiresIn: '12h' }) });
  });

  api.use(auth); // everything below requires a valid token

  api.get('/me', (req, res) => res.json(req.user));
  api.get('/dashboard', async (req, res) => res.json(await items.dashboardCounts(pool, req.user)));
  api.get('/teams/:id/members', async (req, res) => res.json(await items.teamMembers(pool, req.user, req.params.id)));

  api.get('/items', async (req, res) => res.json(await items.listItems(pool, req.user, req.query)));
  api.get('/items/:id', async (req, res) => res.json(await items.getItem(pool, req.user, req.params.id)));
  api.get('/items/:id/activity', async (req, res) => res.json(await items.listActivity(pool, req.user, req.params.id, req.query)));

  const wrap = (u, item) => items.present(u, item);
  api.post('/items', (req, res) => mutate(req, res, async (db) => ({
    status: 201, body: wrap(req.user, await items.createItem(db, req.user, req.body)) })));
  api.patch('/items/:id', (req, res) => mutate(req, res, async (db) => {
    const r = await items.updateItem(db, req.user, req.params.id, req.body);
    return { status: 200, body: wrap(req.user, r.item) };
  }));
  api.post('/items/:id/claim', (req, res) => mutate(req, res, async (db) => {
    const r = await items.claimItem(db, req.user, req.params.id);
    return { status: 200, body: wrap(req.user, r.item) };
  }));
  api.post('/items/:id/assign', (req, res) => mutate(req, res, async (db) => {
    const r = await items.assignItem(db, req.user, req.params.id, req.body);
    return { status: 200, body: wrap(req.user, r.item) };
  }));
  api.post('/items/:id/transition', (req, res) => mutate(req, res, async (db) => {
    const r = await items.transitionItem(db, req.user, req.params.id, req.body);
    return { status: 200, body: wrap(req.user, r.item) };
  }));
  api.post('/items/:id/comments', (req, res) => mutate(req, res, async (db) => ({
    status: 201, body: await items.addComment(db, req.user, req.params.id, req.body) })));

  api.get('/notifications', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, item_id, kind, message, created_at, read_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 30`, [req.user.id]);
    const { rows: [c] } = await pool.query(`SELECT count(*) n FROM notifications WHERE user_id=$1 AND read_at IS NULL`, [req.user.id]);
    res.json({ unread: c.n, notifications: rows });
  });
  api.post('/notifications/read', async (req, res) => {
    await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [req.user.id]);
    res.json({ ok: true });
  });

  api.use((req, res) => { throw new AppError(404, 'NOT_FOUND', 'Unknown endpoint'); });
  app.use('/api', api);

  // Serve the built React app in production (docker image).
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));
  }

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid JSON body' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
  return app;
}
