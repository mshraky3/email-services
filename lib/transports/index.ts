/**
 * Transport registry and routing.
 *
 * Routing is the single most important quota decision in the system: which
 * messages consume the scarce Resend budget and which do not. Only `resend`
 * sends are counted against the 100/day ledger.
 */

import type { Audience, SendResult, TransportName } from '../types.ts';
import type { Priority } from '../quota.ts';
import * as resend from './resend.ts';
import * as gmail from './gmail.ts';
import type { OutboundMessage } from './resend.ts';

export type { OutboundMessage } from './resend.ts';

/** Dry-run sink. Records intent, sends nothing. */
async function noopSend(msg: OutboundMessage): Promise<SendResult> {
  return { id: `dry_${msg.idempotencyKey}`, transport: 'noop', dryRun: true };
}

export const transports: Record<TransportName, (m: OutboundMessage) => Promise<SendResult>> = {
  resend: resend.send,
  gmail: gmail.send,
  noop: noopSend,
};

export interface RouteInput {
  audience: Audience;
  priority: Priority;
  transportHint: TransportName | null;
  allowedTransports: TransportName[];
  /** True when our own ledger or the provider says the Resend budget is gone. */
  resendExhausted: boolean;
  dryRun: boolean;
  /**
   * Best priority allowed to overflow onto Gmail once Resend is exhausted.
   * Default 2: urgent, transactional and operational mail spills over; P3/P4
   * are discretionary and simply wait for the budget to reset.
   */
  gmailFallbackMaxPriority?: Priority;
}

/**
 * Pick a transport.
 *
 * RESEND IS THE PRIMARY SENDER. Everything goes over the verified domain,
 * which is the only way mail reliably reaches an inbox — Gmail SMTP from a
 * cloud host is unauthenticated for this domain, lands in spam, and has
 * previously been hard-blocked outright (534 WebLoginRequired), which is why
 * SQB abandoned it in the first place.
 *
 * GMAIL IS AN OVERFLOW VALVE, nothing more. It carries mail only when the
 * Resend budget is actually gone, on the principle that a message landing in
 * spam still beats one that never left.
 *
 * Order of reasoning:
 *   1. Dry run wins over everything — shadow mode must never send.
 *   2. An explicit policy hint wins next, for the rare deliberate exception.
 *   3. Resend budget exhausted + the message cannot wait -> Gmail.
 *      P3/P4 are excluded: a streak reminder is not worth spending
 *      deliverability on, and the queue will send it tomorrow.
 *   4. Otherwise Resend.
 */
export function pickTransport(input: RouteInput): TransportName {
  if (input.dryRun) return 'noop';

  const allow = (t: TransportName): boolean =>
    input.allowedTransports.includes(t) && (t !== 'gmail' || gmail.isConfigured());

  if (input.transportHint && allow(input.transportHint)) return input.transportHint;

  const overflowLimit = input.gmailFallbackMaxPriority ?? 2;
  if (input.resendExhausted && input.priority <= overflowLimit && allow('gmail')) {
    return 'gmail';
  }

  return 'resend';
}

/** Only Resend sends are rationed — this is what the quota ledger counts. */
export function countsAgainstQuota(transport: TransportName): boolean {
  return transport === 'resend';
}

export { lastRateLimit } from './resend.ts';
