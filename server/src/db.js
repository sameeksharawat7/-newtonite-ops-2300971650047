import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(20, Number); // bigint ids/counts -> JS numbers (safe at our scale)

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export const query = (text, params) => pool.query(text, params);

/** Run fn inside a single transaction. Any throw rolls everything back. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
