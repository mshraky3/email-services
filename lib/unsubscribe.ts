/**
 * One-click unsubscribe tokens.
 *
 * Gmail and Yahoo require `List-Unsubscribe-Post` to act without a confirmation
 * page, and bulk mail without a working opt-out is the fastest route to being
 * classified as spam. Since all four projects now share ONE domain and ONE
 * reputation, that risk is shared too.
 *
 * COMPATIBILITY REQUIREMENT
 *   MEDQIZE already has HMAC unsubscribe links sitting in real inboxes. Those
 *   must keep working forever, so `verify` also accepts the legacy format
 *   (a bare HMAC of the account id under SQB's ADMIN_KEY) when
 *   LEGACY_UNSUB_SECRET is configured. Never break a link already delivered.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UnsubPayload {
  project: string;
  email: string;
  scope: string;
  iat: number;
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function secret(): string {
  const s = process.env.UNSUB_SECRET || process.env.ADMIN_KEY;
  if (!s) throw new Error('UNSUB_SECRET (or ADMIN_KEY) must be set to mint unsubscribe links.');
  return s;
}

export function mintToken(payload: Omit<UnsubPayload, 'iat'>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  return `${body}.${sign(body, secret())}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type VerifyResult =
  | { valid: true; payload: UnsubPayload }
  | { valid: true; legacy: true; accountId: string }
  | { valid: false };

export function verifyToken(token: string): VerifyResult {
  const [body, sig] = token.split('.');

  if (body && sig) {
    if (safeEqual(sig, sign(body, secret()))) {
      try {
        return { valid: true, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) };
      } catch {
        return { valid: false };
      }
    }
  }

  // Legacy MEDQIZE form: ?u=<accountId>&t=<hmac(accountId)>
  const legacySecret = process.env.LEGACY_UNSUB_SECRET;
  if (legacySecret && body && sig && safeEqual(sig, sign(body, legacySecret))) {
    return { valid: true, legacy: true, accountId: body };
  }

  return { valid: false };
}

export function unsubscribeUrl(payload: Omit<UnsubPayload, 'iat'>): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  return `${base}/u/${mintToken(payload)}`;
}

/**
 * Headers that make a mail client show a native unsubscribe control.
 * Applied to P3/P4 only — you cannot opt out of your own password reset.
 */
export function listUnsubscribeHeaders(payload: Omit<UnsubPayload, 'iat'>): Record<string, string> {
  const url = unsubscribeUrl(payload);
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
