/**
 * Postgres access. Neon over `pg`, matching how all four sibling projects
 * already talk to their databases.
 *
 * Use the -pooler Neon host in DATABASE_URL. Serverless functions open a
 * connection per invocation and will exhaust a direct endpoint under any real
 * concurrency.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let _pool: Pool | null = null;

export function pool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — the gateway cannot run without a database.');
    }
    _pool = new Pool({
      connectionString,
      max: 3, // serverless: keep it small, the pooler does the real multiplexing
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(text, params);
  return res.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run inside a transaction, rolling back on any throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Single-flight guard for the drain loop, as an EXPIRING LEASE.
 *
 * Two drainers running at once would both claim rows and both pace their own
 * sends, doubling the effective request rate against the provider. `FOR UPDATE
 * SKIP LOCKED` already prevents double-sending a row; this prevents the
 * rate-limit breach.
 *
 * A `pg_try_advisory_lock` would be the obvious tool and is what this used to
 * be — but it is session-scoped, and that is exactly wrong here. Vercel FREEZES
 * a lambda the instant it returns a response, so an interrupted drain keeps
 * holding the advisory lock until its TCP session eventually dies, blocking
 * every other drainer until then. Observed live.
 *
 * A lease has no such failure mode: a dead holder stops renewing and the lease
 * simply expires. `ttlSeconds` therefore bounds the worst-case stall.
 */
export async function withLease<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false; result: null }> {
  const holder = `${process.env.VERCEL_REGION ?? 'local'}:${Math.random().toString(36).slice(2, 10)}`;

  // Take the lease only if nobody holds it, or the current holder's has expired.
  const got = await query<{ holder: string }>(
    `INSERT INTO gateway_locks (name, holder, acquired_at, expires_at)
     VALUES ($1, $2, NOW(), NOW() + ($3 || ' seconds')::interval)
     ON CONFLICT (name) DO UPDATE
        SET holder = EXCLUDED.holder, acquired_at = NOW(), expires_at = EXCLUDED.expires_at
      WHERE gateway_locks.expires_at < NOW()
     RETURNING holder`,
    [name, holder, String(ttlSeconds)],
  );

  if (got[0]?.holder !== holder) return { acquired: false, result: null };

  try {
    return { acquired: true, result: await fn() };
  } finally {
    // Release early so the next tick does not have to wait out the TTL.
    // Scoped to our own holder id so we can never release someone else's lease.
    await query(`UPDATE gateway_locks SET expires_at = NOW() WHERE name = $1 AND holder = $2`, [name, holder])
      .catch(() => {});
  }
}

let _schemaReady: Promise<void> | null = null;

/**
 * Apply schema.sql. Idempotent, and memoised per process so warm lambdas do
 * not re-run the DDL on every request.
 */
export function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const sql = readFileSync(join(process.cwd(), 'lib', 'schema.sql'), 'utf8');
      await pool().query(sql);
    })().catch((err) => {
      _schemaReady = null; // let the next request retry rather than caching the failure
      throw err;
    });
  }
  return _schemaReady;
}
