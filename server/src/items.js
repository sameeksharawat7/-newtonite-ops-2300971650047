// Business logic for work items. Every function takes `db` (a transaction client for writes,
// the pool for reads) so the item change, its activity event and its outbox job commit together.
import { AppError, notFound } from './errors.js';
import { check, authorize } from './permissions.js';
import { TRANSITIONS, STATUSES } from './workflow.js';
import { enqueue } from './jobs.js';
import { PRIORITIES, TYPES, toId, validateNewItem, validatePatch, validateTransition, validateAssign, validateComment } from './validation.js';

const COLS = `w.id, w.team_id, t.name AS team_name, w.title, w.type, w.priority, w.status,
  w.assignee_id, a.name AS assignee_name, w.created_by, c.name AS created_by_name,
  w.due_date::text AS due_date, w.version, w.created_at, w.updated_at`;
const FROM = `FROM work_items w JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id JOIN users c ON c.id = w.created_by`;

const fetchItem = async (db, id) =>
  (await db.query(`SELECT ${COLS}, w.description ${FROM} WHERE w.id = $1`, [id])).rows[0];

/** Load an item the user may at least read; otherwise 404 (do not leak existence). */
async function mustGet(db, user, id) {
  const item = await fetchItem(db, toId(id));
  if (!item) throw notFound('Work item');
  authorize(user, 'read', item);
  return item;
}

/** Attach server-computed affordances so the UI never re-implements permission logic. */
export function present(user, item) {
  const can = (a) => check(user, a, item).ok;
  const open = item.status !== 'closed';
  return {
    ...item,
    permissions: {
      edit: open && can('edit'),
      claim: item.status === 'open' && !item.assignee_id && can('claim'),
      assign: open && can('assign'),
      comment: can('comment'),
      transitions: Object.entries(TRANSITIONS[item.status])
        .filter(([, rule]) => can(rule.action)).map(([to]) => to),
    },
  };
}

const addEvent = (db, itemId, actorId, type, data = {}) =>
  db.query(`INSERT INTO activity_events (item_id, actor_id, type, data) VALUES ($1,$2,$3,$4)`, [itemId, actorId, type, JSON.stringify(data)]);

const staleConflict = (user, item) =>
  new AppError(409, 'VERSION_CONFLICT', 'This item was changed by someone else', { current: present(user, item) });

// ---------------------------------------------------------------- writes

export async function createItem(db, user, input) {
  const v = validateNewItem(input);
  authorize(user, 'create', { team_id: v.team_id, assignee_id: null });
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO work_items (team_id, title, description, type, priority, due_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [v.team_id, v.title, v.description, v.type, v.priority, v.due_date, user.id]);
  await addEvent(db, id, user.id, 'created', { title: v.title, type: v.type, priority: v.priority });
  return fetchItem(db, id);
}

export async function updateItem(db, user, id, input) {
  const item = await mustGet(db, user, id);
  authorize(user, 'edit', item);
  if (item.status === 'closed') throw new AppError(409, 'ITEM_CLOSED', 'Closed items cannot be edited');
  const { version, fields } = validatePatch(input);
  if (version !== item.version) throw staleConflict(user, item);

  const changes = {};
  for (const [k, v] of Object.entries(fields)) if (v !== item[k]) changes[k] = { from: item[k], to: v };
  if (!Object.keys(changes).length) return { item, noop: true };

  const sets = [], vals = [];
  for (const [k, c] of Object.entries(changes)) { vals.push(c.to); sets.push(`${k} = $${vals.length}`); } // keys come from validatePatch whitelist
  vals.push(item.id, version);
  // Optimistic lock: only succeeds if nobody changed the row since the client read it.
  const r = await db.query(
    `UPDATE work_items SET ${sets.join(', ')}, version = version + 1, updated_at = now()
      WHERE id = $${vals.length - 1} AND version = $${vals.length}`, vals);
  if (r.rowCount === 0) throw staleConflict(user, await fetchItem(db, item.id));

  if (changes.priority) await addEvent(db, item.id, user.id, 'priority_changed', changes.priority);
  const { priority, ...rest } = changes;
  if (Object.keys(rest).length) await addEvent(db, item.id, user.id, 'updated', { changes: rest });
  return { item: await fetchItem(db, item.id) };
}

export async function claimItem(db, user, id) {
  const item = await mustGet(db, user, id);
  authorize(user, 'claim', item);
  // THE atomic claim: the WHERE clause is the lock. Two racers => the DB lets exactly one UPDATE match.
  const r = await db.query(
    `UPDATE work_items SET assignee_id = $1, status = 'in_progress', version = version + 1, updated_at = now()
      WHERE id = $2 AND assignee_id IS NULL AND status = 'open'`, [user.id, item.id]);
  if (r.rowCount === 0) {
    const cur = await fetchItem(db, item.id);
    if (cur.assignee_id === user.id) return { item: cur, noop: true }; // double-click / retry => same result
    throw new AppError(409, 'ALREADY_CLAIMED',
      cur.assignee_name ? `Already claimed by ${cur.assignee_name}` : `Item cannot be claimed while ${cur.status}`,
      { current: present(user, cur) });
  }
  await addEvent(db, item.id, user.id, 'claimed', {});
  return { item: await fetchItem(db, item.id) };
}

export async function assignItem(db, user, id, input) {
  const { assignee_id, version } = validateAssign(input);
  const item = await mustGet(db, user, id);
  authorize(user, 'assign', item);
  if (item.status === 'closed') throw new AppError(409, 'ITEM_CLOSED', 'Closed items cannot be reassigned');
  const { rows: [m] } = await db.query(
    `SELECT u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id=$1 AND m.user_id=$2`, [item.team_id, assignee_id]);
  if (!m || m.role === 'viewer') throw new AppError(400, 'VALIDATION', 'Assignee must be a member of the item\'s team (not a viewer)');
  if (version !== item.version) throw staleConflict(user, item);
  if (item.assignee_id === assignee_id) return { item, noop: true };

  const r = await db.query(
    `UPDATE work_items SET assignee_id = $1, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
            version = version + 1, updated_at = now()
      WHERE id = $2 AND version = $3`, [assignee_id, item.id, version]);
  if (r.rowCount === 0) throw staleConflict(user, await fetchItem(db, item.id));

  await addEvent(db, item.id, user.id, 'assigned', {
    from: item.assignee_id ? { id: item.assignee_id, name: item.assignee_name } : null,
    to: { id: assignee_id, name: m.name },
  });
  if (assignee_id !== user.id) {
    await enqueue(db, 'notify_user', {
      userId: assignee_id, itemId: item.id, kind: 'assigned',
      message: `${user.name} assigned you: ${item.title}`, key: `assign:${item.id}:${version + 1}`,
    }, `assign:${item.id}:${version + 1}`);
  }
  return { item: await fetchItem(db, item.id) };
}

export async function transitionItem(db, user, id, input) {
  const { to, version, comment } = validateTransition(input);
  const item = await mustGet(db, user, id);
  const rule = TRANSITIONS[item.status]?.[to];
  if (!rule) {
    throw new AppError(409, 'INVALID_TRANSITION', `Cannot move from ${item.status} to ${to}`,
      { allowed: Object.keys(TRANSITIONS[item.status]) });
  }
  authorize(user, rule.action, item);
  if (version !== item.version) throw staleConflict(user, item);

  const r = await db.query(
    `UPDATE work_items SET status = $1, assignee_id = CASE WHEN $2::boolean THEN NULL ELSE assignee_id END,
            version = version + 1, updated_at = now()
      WHERE id = $3 AND version = $4 AND status = $5`,
    [to, !!rule.clearAssignee, item.id, version, item.status]);
  if (r.rowCount === 0) throw staleConflict(user, await fetchItem(db, item.id));

  const newVersion = version + 1;
  await addEvent(db, item.id, user.id, 'status_changed', { from: item.status, to, comment });

  // Secondary work goes to the outbox in the SAME transaction (sent later by the worker).
  if (to === 'awaiting_approval') {
    await enqueue(db, 'notify_approvers', { itemId: item.id, version: newVersion }, `approvers:${item.id}:${newVersion}`);
  } else if (item.status === 'awaiting_approval' && to === 'in_progress' && item.assignee_id) {
    await enqueue(db, 'notify_user', { userId: item.assignee_id, itemId: item.id, kind: 'rejected',
      message: `Changes requested on: ${item.title}`, key: `rejected:${item.id}:${newVersion}` }, `rejected:${item.id}:${newVersion}`);
  } else if (to === 'resolved' && item.created_by !== user.id) {
    await enqueue(db, 'notify_user', { userId: item.created_by, itemId: item.id, kind: 'resolved',
      message: `Resolved: ${item.title}`, key: `resolved:${item.id}:${newVersion}` }, `resolved:${item.id}:${newVersion}`);
  }
  return { item: await fetchItem(db, item.id) };
}

export async function addComment(db, user, id, input) {
  const { body } = validateComment(input);
  const item = await mustGet(db, user, id);
  authorize(user, 'comment', item);
  // Comments deliberately do NOT bump item.version: commenting must never cause an edit conflict.
  const { rows: [e] } = await db.query(
    `INSERT INTO activity_events (item_id, actor_id, type, data) VALUES ($1,$2,'comment',$3) RETURNING id, type, data, created_at, actor_id`,
    [item.id, user.id, JSON.stringify({ body })]);
  return { ...e, actor_name: user.name };
}

// ---------------------------------------------------------------- reads

export const getItem = async (db, user, id) => present(user, await mustGet(db, user, id));

const csv = (v, allowed, label) => {
  const list = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (const x of list) if (!allowed.includes(x)) throw new AppError(400, 'VALIDATION', `Invalid ${label}: ${x}`);
  return list;
};
const leadTeamIds = (user) => user.memberships.filter((m) => m.role === 'lead' || m.role === 'admin').map((m) => m.team_id);

export async function listItems(db, user, q = {}) {
  const teamIds = user.memberships.map((m) => m.team_id);          // visibility scope: ALWAYS applied
  if (!teamIds.length) return { items: [], next_cursor: null };
  const params = [teamIds];
  const where = ['w.team_id = ANY($1)'];
  const add = (sql, ...vals) => { // sql uses {} placeholders
    let s = sql; for (const v of vals) { params.push(v); s = s.replace('{}', `$${params.length}`); } where.push(s);
  };

  if (q.team_id) add('w.team_id = {}', toId(q.team_id, 'team_id'));
  if (q.status) add('w.status = ANY({})', csv(q.status, STATUSES, 'status'));
  if (q.priority) add('w.priority = ANY({})', csv(q.priority, PRIORITIES, 'priority'));
  if (q.type) add('w.type = ANY({})', csv(q.type, TYPES, 'type'));
  if (q.assignee === 'me') add('w.assignee_id = {}', user.id);
  else if (q.assignee === 'unassigned') where.push('w.assignee_id IS NULL');
  else if (q.assignee) add('w.assignee_id = {}', toId(q.assignee, 'assignee'));
  if (q.overdue === 'true') where.push(`w.due_date < current_date AND w.status NOT IN ('resolved','closed')`);
  if (q.q && String(q.q).trim()) {
    const text = String(q.q).trim().slice(0, 200);
    if (/^#?\d+$/.test(text)) add(`(w.id = {} OR w.search @@ websearch_to_tsquery('english', {}))`, Number(text.replace('#', '')), text);
    else add(`w.search @@ websearch_to_tsquery('english', {})`, text);
  }
  // Dashboard views ("what needs my attention")
  switch (q.view) {
    case 'assigned_to_me': add(`w.assignee_id = {} AND w.status NOT IN ('resolved','closed')`, user.id); break;
    case 'unassigned_urgent': where.push(`w.assignee_id IS NULL AND w.status = 'open' AND w.priority = 'urgent'`); break;
    case 'awaiting_my_approval':
      add(`w.status = 'awaiting_approval' AND w.team_id = ANY({}) AND w.assignee_id IS DISTINCT FROM {}`, leadTeamIds(user), user.id); break;
    case undefined: case 'all': case '': break;
    default: throw new AppError(400, 'VALIDATION', 'Unknown view');
  }
  // Keyset pagination: stable and O(log n) at any depth, unlike OFFSET.
  if (q.cursor) {
    let c; try { c = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString()); } catch { c = null; }
    if (!c || typeof c.u !== 'string' || !Number.isSafeInteger(c.i)) throw new AppError(400, 'VALIDATION', 'Invalid cursor');
    add('(w.updated_at, w.id) < ({}::timestamptz, {})', c.u, c.i);
  }
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 100);
  params.push(limit + 1);
  const { rows } = await db.query(
    `SELECT ${COLS}, w.updated_at::text AS _ts ${FROM} WHERE ${where.join(' AND ')}
      ORDER BY w.updated_at DESC, w.id DESC LIMIT $${params.length}`, params);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next_cursor = hasMore ? Buffer.from(JSON.stringify({ u: last._ts, i: last.id })).toString('base64url') : null;
  return { items: page.map(({ _ts, ...r }) => r), next_cursor };
}

export async function dashboardCounts(db, user) {
  const teamIds = user.memberships.map((m) => m.team_id);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0].n;
  const [assigned_to_me, unassigned_urgent, awaiting_my_approval, overdue] = await Promise.all([
    one(`SELECT count(*) n FROM work_items WHERE assignee_id=$1 AND status NOT IN ('resolved','closed')`, [user.id]),
    one(`SELECT count(*) n FROM work_items WHERE team_id = ANY($1) AND assignee_id IS NULL AND status='open' AND priority='urgent'`, [teamIds]),
    one(`SELECT count(*) n FROM work_items WHERE team_id = ANY($1) AND status='awaiting_approval' AND assignee_id IS DISTINCT FROM $2`, [leadTeamIds(user), user.id]),
    one(`SELECT count(*) n FROM work_items WHERE team_id = ANY($1) AND due_date < current_date AND status NOT IN ('resolved','closed')`, [teamIds]),
  ]);
  return { assigned_to_me, unassigned_urgent, awaiting_my_approval, overdue };
}

export async function listActivity(db, user, id, { cursor, limit } = {}) {
  const item = await mustGet(db, user, id);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const cur = cursor ? toId(cursor, 'cursor') : null;
  const { rows } = await db.query(
    `SELECT e.id, e.type, e.data, e.created_at, e.actor_id, u.name AS actor_name
       FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.item_id = $1 AND ($2::bigint IS NULL OR e.id < $2) ORDER BY e.id DESC LIMIT $3`, [item.id, cur, lim + 1]);
  const page = rows.slice(0, lim);
  return { events: page, next_cursor: rows.length > lim ? page[page.length - 1].id : null };
}

export async function teamMembers(db, user, teamId) {
  const id = toId(teamId, 'team id');
  authorize(user, 'read', { team_id: id });
  const { rows } = await db.query(
    `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 AND m.role <> 'viewer' ORDER BY u.name`, [id]);
  return rows;
}
