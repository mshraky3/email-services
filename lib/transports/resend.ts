/**
 * Resend HTTP API transport.
 *
 * The HTTP API is used rather than SMTP (which is what MEDQIZE and HR- do
 * today) because it gives three things the gateway needs and SMTP cannot
 * provide: a provider message id to correlate webhooks against, an
 * Idempotency-Key so a retry cannot double-send, and machine-readable quota
 * errors (`daily_quota_exceeded`) instead of an opaque SMTP failure.
 */

import { TransportError, type Attachment, type SendResult } from '../types.ts';

const ENDPOINT = 'https://api.resend.com/emails';

export interface OutboundMessage {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  /** Stable across retries — this is what makes the stuck-row reclaim safe. */
  idempotencyKey: string;
}

/** Latest rate-limit headers Resend returned. Surfaced on the dashboard. */
export const lastRateLimit: {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
  at?: string;
} = {};

function classify(status: number, body: string): TransportError {
  let errorName = '';
  try {
    errorName = String(JSON.parse(body)?.name ?? '');
  } catch {
    /* body was not JSON — fall through to status-based classification */
  }

  if (errorName === 'daily_quota_exceeded' || errorName === 'monthly_quota_exceeded') {
    // Authoritative: the provider says we are out, whatever our own ledger
    // thinks. The drain loop treats this as a circuit breaker rather than a
    // per-message failure, because retrying it would just burn attempts.
    return new TransportError('quota', `Resend quota exhausted (${errorName})`, status);
  }
  if (status === 429) return new TransportError('rate_limit', 'Resend rate limit', status);
  if (status >= 500) return new TransportError('server', `Resend ${status}: ${body.slice(0, 300)}`, status);
  return new TransportError('validation', `Resend ${status}: ${body.slice(0, 300)}`, status);
}

export async function send(msg: OutboundMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new TransportError('validation', 'RESEND_API_KEY is not set');

  const payload: Record<string, unknown> = {
    from: msg.from,
    to: [msg.to],
    subject: msg.subject,
  };
  if (msg.html) payload.html = msg.html;
  if (msg.text) payload.text = msg.text;
  if (msg.replyTo) payload.reply_to = msg.replyTo;
  if (msg.headers && Object.keys(msg.headers).length) payload.headers = msg.headers;
  if (msg.attachments?.length) {
    payload.attachments = msg.attachments.map((a) =>
      a.url
        ? { filename: a.filename, path: a.url }
        : { filename: a.filename, content: a.content, content_type: a.content_type },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': msg.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    // An aborted request may still have been accepted upstream. The caller has
    // already reserved the quota slot and will retry with the SAME idempotency
    // key, so Resend dedupes it rather than sending twice.
    throw new TransportError(aborted ? 'timeout' : 'network', (err as Error)?.message ?? 'network failure');
  } finally {
    clearTimeout(timer);
  }

  const limit = res.headers.get('ratelimit-limit');
  const remaining = res.headers.get('ratelimit-remaining');
  const reset = res.headers.get('ratelimit-reset');
  if (limit) lastRateLimit.limit = Number(limit);
  if (remaining) lastRateLimit.remaining = Number(remaining);
  if (reset) lastRateLimit.resetSeconds = Number(reset);
  lastRateLimit.at = new Date().toISOString();

  const body = await res.text();
  if (!res.ok) {
    const err = classify(res.status, body);
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.retryAfterSeconds = Number(retryAfter);
    throw err;
  }

  let id: string | null = null;
  try {
    id = JSON.parse(body)?.id ?? null;
  } catch {
    /* a 2xx with an unparseable body still counts as sent */
  }
  return { id, transport: 'resend' };
}
