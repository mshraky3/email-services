/**
 * Which transport carries a message — pure, so it can be tested without a database.
 *
 * Order: dry run -> explicit hint -> Resend account 1 while it has budget ->
 * Resend account 2 (the second account on the second domain) while it has budget
 * -> Gmail -> Resend 1 as the last resort (it will answer with a quota error and
 * the delivery loop handles that).
 *
 * `resend2` is an EXTENSION of Resend for quota purposes: a project that is
 * allowed to use 'resend' may use it, so no per-project row has to change.
 */
import type { TransportName } from './types.ts';

export interface ChoiceInput {
  dryRun: boolean;
  hint: TransportName | null;
  /** Is this project allowed to use the given transport at all (and is it configured)? */
  allowed: (t: TransportName) => boolean;
  resendAvailable: boolean;
  resend2Configured: boolean;
  resend2Available: boolean;
}

export function chooseTransport(i: ChoiceInput): TransportName {
  if (i.dryRun) return 'noop';
  if (i.hint && i.allowed(i.hint)) return i.hint;
  if (i.resendAvailable) return 'resend';
  if (i.resend2Configured && i.resend2Available && i.allowed('resend')) return 'resend2';
  if (i.allowed('gmail')) return 'gmail';
  return 'resend';
}

/** The mail domain a given Resend lane sends from (each Resend account verified its own). */
export function mailDomainFor(transport: TransportName, env: Record<string, string | undefined> = process.env): string {
  if (transport === 'resend2') return env.MAIL_DOMAIN_2 || env.MAIL_DOMAIN || 'localhost';
  return env.MAIL_DOMAIN || 'localhost';
}
