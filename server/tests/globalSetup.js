import pg from 'pg';
import { TEST_DB } from '../vitest.config.js';

// Fresh schema for every `npm test` run, then apply the real migrations.
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_DB });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  process.env.DATABASE_URL = TEST_DB;
  const { migrate } = await import('../src/migrate.js');
  const { pool } = await import('../src/db.js');
  await migrate();
  await pool.end();
}
