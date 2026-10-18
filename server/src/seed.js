import bcrypt from 'bcryptjs';
import { pool, tx } from './db.js';
import { pathToFileURL } from 'node:url';

const TEAMS = ['Engineering', 'Payments', 'Customer Support', 'Compliance'];
// email, name, { team: role }
const USERS = [
  ['admin@demo.test',   'Asha Admin',   { Engineering: 'admin', Payments: 'admin', 'Customer Support': 'admin', Compliance: 'admin' }],
  ['lead1@demo.test',   'Lena Lead',    { Engineering: 'lead', Payments: 'lead' }],
  ['lead2@demo.test',   'Liam Lead',    { 'Customer Support': 'lead', Compliance: 'lead' }],
  ['member1@demo.test', 'Mia Member',   { Engineering: 'member', 'Customer Support': 'member' }],
  ['member2@demo.test', 'Max Member',   { Engineering: 'member' }],
  ['member3@demo.test', 'Nina Member',  { Payments: 'member' }],
  ['member4@demo.test', 'Omar Member',  { Payments: 'member', Compliance: 'member' }],
  ['member5@demo.test', 'Priya Member', { 'Customer Support': 'member' }],
  ['member6@demo.test', 'Zoe Member',   { Compliance: 'member' }],
  ['viewer@demo.test',  'Vik Viewer',   { Engineering: 'viewer', Payments: 'viewer', 'Customer Support': 'viewer', Compliance: 'viewer' }],
];

export async function seed(itemCount = Number(process.env.SEED_ITEMS || 5000)) {
  const { rows: [{ n }] } = await pool.query('SELECT count(*) n FROM users');
  if (n > 0) { console.log('Seed skipped: data already present'); return; }
  const hash = bcrypt.hashSync('password123', 10);
  await tx(async (c) => {
    const teamId = {};
    for (const t of TEAMS) teamId[t] = (await c.query('INSERT INTO teams(name) VALUES ($1) RETURNING id', [t])).rows[0].id;
    for (const [email, name, roles] of USERS) {
      const { rows: [u] } = await c.query('INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id', [email, name, hash]);
      for (const [t, role] of Object.entries(roles)) await c.query('INSERT INTO memberships VALUES ($1,$2,$3)', [u.id, teamId[t], role]);
    }
    // Bulk sample items entirely in SQL (fast). Assignees/creators are real non-viewer members of the item's team.
    await c.query(`
      WITH g AS (
        SELECT gs, (SELECT array_agg(id ORDER BY id) FROM teams) AS tids, random() r1, random() r2, random() r3, random() r4 FROM generate_series(1, $1::int) gs
      ), h AS (
        SELECT gs, tids[1 + floor(r4 * array_length(tids,1))::int] AS team_id, r2, r3,
               CASE WHEN r1 < .25 THEN 'open' WHEN r1 < .55 THEN 'in_progress' WHEN r1 < .65 THEN 'awaiting_approval'
                    WHEN r1 < .85 THEN 'resolved' ELSE 'closed' END AS status
          FROM g
      )
      INSERT INTO work_items (team_id, title, description, type, priority, status, assignee_id, created_by, due_date, created_at, updated_at)
      SELECT team_id,
             (ARRAY['Payment failed for order','Checkout timeout on','Customer cannot login to','Refund request for','Database latency spike in',
                    'Compliance review of','Webhook retries failing for','Chargeback dispute on','Production incident in','Approve vendor access for'])[1 + floor(r2*10)::int]
               || ' #' || gs,
             'Sample description for item ' || gs || '. Investigate, follow up, and document the outcome.',
             (ARRAY['incident','customer_issue','payment','compliance','task'])[1 + floor(r3*5)::int],
             CASE WHEN r2 < .10 THEN 'urgent' WHEN r2 < .35 THEN 'high' WHEN r2 < .80 THEN 'medium' ELSE 'low' END,
             status,
             CASE WHEN status = 'open' THEN NULL ELSE (SELECT user_id FROM memberships m WHERE m.team_id = h.team_id AND m.role <> 'viewer' ORDER BY random() LIMIT 1) END,
             (SELECT user_id FROM memberships m WHERE m.team_id = h.team_id AND m.role <> 'viewer' ORDER BY random() LIMIT 1),
             CASE WHEN r3 < .6 THEN current_date + (floor(random()*26) - 5)::int ELSE NULL END,
             now() - random() * interval '30 days',
             now() - random() * interval '30 days'
        FROM h`, [itemCount]);
    await c.query(`UPDATE work_items SET updated_at = created_at + (random() * interval '2 days') WHERE updated_at < created_at`);
    await c.query(`UPDATE work_items SET updated_at = LEAST(updated_at, now())`);
    await c.query(`INSERT INTO activity_events (item_id, actor_id, type, data, created_at)
                   SELECT id, created_by, 'created', jsonb_build_object('title', title, 'type', type, 'priority', priority), created_at FROM work_items`);
  });
  console.log(`Seeded ${TEAMS.length} teams, ${USERS.length} users (password: password123), ${itemCount} items`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seed();
  await pool.end();
}
