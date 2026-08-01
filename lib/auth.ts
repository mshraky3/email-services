/**
 * Per-project API-key authentication.
 *
 * No CORS layer and no URL allowlisting by design — every caller is
 * server-to-server, so a bearer key is the whole gate. Browsers never call this
 * service directly; the one public route (unsubscribe) uses an HMAC token
 * instead.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, query } from './db.ts';
import type { ProjectRow } from './types.ts';

const KEY_BYTES = 24;

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Mint a key. Returned in full exactly once — only the hash is stored.
 * The prefix is safe to log and is what identifies the key in the dashboard.
 */
export function mintKey(slug: string): { key: string; prefix: string; hash: string } {
  const secret = randomBytes(KEY_BYTES).toString('base64url');
  const key = `ek_live_${slug}_${secret}`;
  return { key, prefix: key.slice(0, `ek_live_${slug}_`.length + 8), hash: hashKey(key) };
}

export function bearerFrom(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();
  return req.headers.get('x-api-key');
}

export interface AuthedProject {
  project: ProjectRow;
  keyId: number;
}

/**
 * Resolve a bearer token to its project.
 *
 * The lookup is by hash (indexed, constant work), and the constant-time
 * comparison guards the final equality so a timing side-channel cannot be used
 * to walk the key space.
 */
export async function authenticate(req: Request): Promise<AuthedProject | null> {
  const presented = bearerFrom(req);
  if (!presented) return null;

  const digest = hashKey(presented);
  const row = await one<{ id: number; key_hash: string; project_id: number }>(
    `SELECT id, key_hash, project_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
    [digest],
  );
  if (!row) return null;

  const a = Buffer.from(row.key_hash, 'utf8');
  const b = Buffer.from(digest, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const project = await one<ProjectRow>(`SELECT * FROM projects WHERE id = $1 AND active`, [row.project_id]);
  if (!project) return null;

  // Best-effort: a failed last_used_at write must never fail a send.
  query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});

  return { project, keyId: row.id };
}

/**
 * Guard for /api/v1/drain and the admin surface.
 *
 * Accepts any of the named env vars, because Vercel's own cron sends
 * `Authorization: Bearer $CRON_SECRET` and cannot be told to use a different
 * variable name.
 */
export function checkSecret(req: Request, ...envVars: Array<'DRAIN_SECRET' | 'ADMIN_KEY' | 'CRON_SECRET'>): boolean {
  const presented = bearerFrom(req) ?? new URL(req.url).searchParams.get('key');
  if (!presented) return false;

  return envVars.some((name) => {
    const expected = process.env[name];
    // Fail closed. An unset secret must never mean "everyone is authorised" —
    // that is how MEDQIZE's cronAuth behaves today, and it is a live hole.
    if (!expected) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
