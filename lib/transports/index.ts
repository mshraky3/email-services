/**
 * Transport registry.
 *
 * Which transport carries a given message is decided in lib/send.ts — this
 * module only owns the implementations and the dry-run sink.
 */

import type { SendResult, TransportName } from '../types.ts';
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

/** Only Resend sends are counted against the daily budget. */
export function countsAgainstQuota(transport: TransportName): boolean {
  return transport === 'resend';
}

export { lastRateLimit } from './resend.ts';
export { isConfigured as gmailConfigured } from './gmail.ts';
