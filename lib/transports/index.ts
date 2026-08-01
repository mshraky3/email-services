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
}

/**
 * Pick a transport.
 *
 * Order of reasoning:
 *   1. Dry run wins over everything — shadow mode must never send.
 *   2. An explicit policy hint wins next (this is how portfolio stays on Gmail).
 *   3. Owner-facing mail goes to Gmail: zero Resend cost, and its deliverability
 *      characteristics only affect the owner's own inbox.
 *   4. Break-glass: a P0 with no Resend budget left goes over Gmail rather than
 *      failing. A password reset landing in spam beats one never arriving.
 *   5. Everything else is user-facing mail on the verified domain.
 */
export function pickTransport(input: RouteInput): TransportName {
  if (input.dryRun) return 'noop';

  const allow = (t: TransportName): boolean =>
    input.allowedTransports.includes(t) && (t !== 'gmail' || gmail.isConfigured());

  if (input.transportHint && allow(input.transportHint)) return input.transportHint;

  if (input.audience === 'owner' && allow('gmail')) return 'gmail';

  if (input.priority === 0 && input.resendExhausted && allow('gmail')) return 'gmail';

  return 'resend';
}

/** Only Resend sends are rationed — this is what the quota ledger counts. */
export function countsAgainstQuota(transport: TransportName): boolean {
  return transport === 'resend';
}

export { lastRateLimit } from './resend.ts';
