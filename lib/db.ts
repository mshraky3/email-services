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
 * Single-flight guard for the drain loop.
 *
 * Two drainers running at once would both claim rows and both pace their own
 * sends, doubling the effective request rate against Resend. `FOR UPDATE SKIP
 * LOCKED` already prevents double-sending the same row; this prevents the
 * rate-limit breach.
 *
 * Advisory locks are session-scoped, so the lock must be taken and released on
 * the SAME client — hence the explicit connection rather than `query()`.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false; result: null }> {
  const client = await pool().connect();
  try {
    const got = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
      [key],
    );
    if (!got.rows[0]?.ok) return { acquired: false, result: null };
    try {
      return { acquired: true, result: await fn() };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
    }
  } finally {
    client.release();
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
