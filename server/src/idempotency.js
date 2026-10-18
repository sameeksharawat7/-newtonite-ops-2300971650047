import crypto from 'node:crypto';
import { tx } from './db.js';
import { AppError } from './errors.js';

/**
 * Wraps EVERY mutating endpoint. fn(client) runs inside ONE transaction and returns { status, body }.
 *
 * If the client sends an Idempotency-Key header we first INSERT the key row in the same transaction.
 * - Concurrent duplicate: the unique index makes the 2nd INSERT wait for the 1st to commit,
 *   then it sees a conflict and replays the stored response. Work is done exactly once.
 * - 1st attempt rolled back (e.g. 409): the key row rolls back too, so a retry runs normally.
 */
export async function mutate(req, res, fn) {
  const key = req.get('Idempotency-Key');
  if (key && key.length > 200) throw new AppError(400, 'VALIDATION', 'Idempotency-Key too long');

  const result = await tx(async (client) => {
    let hash;
    if (key) {
      hash = crypto.createHash('sha256').update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`).digest('hex');
      const ins = await client.query(
        `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [req.user.id, key, hash]);
      if (ins.rowCount === 0) {
        const { rows: [row] } = await client.query(
          `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id=$1 AND key=$2`,
          [req.user.id, key]);
        if (row.request_hash !== hash) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
        }
        return { status: row.response_status, body: row.response_body, replayed: true };
      }
    }
    const out = await fn(client);
    if (key) {
      await client.query(`UPDATE idempotency_keys SET response_status=$3, response_body=$4 WHERE user_id=$1 AND key=$2`,
        [req.user.id, key, out.status, JSON.stringify(out.body)]);
    }
    return out;
  });

  if (result.replayed) res.set('Idempotent-Replay', 'true');
  res.status(result.status).json(result.body);
}
