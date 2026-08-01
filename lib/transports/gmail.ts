/**
 * Gmail SMTP transport — the capacity multiplier.
 * ---------------------------------------------------------------------------
 * Roughly a quarter of all mail across these projects is the owner emailing
 * himself: MEDQIZE's 9 owner notifications, HR-'s error reports, portfolio's
 * 5 types. None of it needs the verified domain's reputation, and every one of
 * those sends would otherwise consume the shared 100/day Resend budget.
 *
 * Gmail gives 500/day on a completely separate quota, so routing
 * `audience = 'owner'` here makes that traffic effectively free.
 *
 * KNOWN WEAKNESS, ACCEPTED DELIBERATELY
 *   MEDQIZE abandoned Gmail SMTP in July 2026: Vercel's rotating egress IPs
 *   occasionally trip `534 WebLoginRequired`, and unauthenticated Gmail mail
 *   lands in spam. That is tolerable here precisely because this transport only
 *   ever carries owner-facing, digested mail — a Gmail outage delays your own
 *   digest, it does not break a user flow. It must never carry OTPs or
 *   invoices; `pickTransport` enforces that.
 *
 * Requires a Gmail App Password, not the account password.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { TransportError, type SendResult } from '../types.ts';
import type { OutboundMessage } from './resend.ts';

let _transport: Transporter | null = null;

function transport(): Transporter {
  if (!_transport) {
    const user = process.env.GMAIL_SMTP_USER;
    const pass = process.env.GMAIL_SMTP_PASS;
    if (!user || !pass) {
      throw new TransportError('validation', 'GMAIL_SMTP_USER / GMAIL_SMTP_PASS are not set');
    }
    _transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS on 587
      auth: { user, pass },
      // Serverless: no connection pool — a lambda is frozen between
      // invocations and a held socket is dead by the time it thaws.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return _transport;
}

export function isConfigured(): boolean {
  return Boolean(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_PASS);
}

export async function send(msg: OutboundMessage): Promise<SendResult> {
  // Gmail will rewrite the envelope sender to the authenticated account
  // regardless, so use it explicitly and keep only the display name from the
  // caller. Sending as a domain Gmail cannot authenticate for guarantees spam.
  const account = process.env.GMAIL_FROM_ADDRESS || process.env.GMAIL_SMTP_USER!;
  const displayName = /^"?([^"<]*)"?\s*</.exec(msg.from)?.[1]?.trim();
  const from = displayName ? `"${displayName}" <${account}>` : account;

  try {
    const info = await transport().sendMail({
      from,
      to: msg.to,
      replyTo: msg.replyTo ?? undefined,
      subject: msg.subject,
      html: msg.html ?? undefined,
      text: msg.text ?? undefined,
      headers: msg.headers,
      attachments: msg.attachments?.map((a) =>
        a.url
          ? { filename: a.filename, path: a.url }
          : { filename: a.filename, content: a.content, encoding: 'base64', contentType: a.content_type },
      ),
    });
    return { id: info.messageId ?? null, transport: 'gmail' };
  } catch (err) {
    const e = err as Error & { responseCode?: number; code?: string };
    const code = e.responseCode ?? 0;

    // 534 WebLoginRequired / 535 auth failures are not transient — retrying
    // just burns attempts until Google unblocks the IP.
    if (code === 534 || code === 535) {
      throw new TransportError('validation', `Gmail refused authentication (${code}): ${e.message}`, code);
    }
    if (code === 421 || code === 450 || code === 451 || code === 452) {
      throw new TransportError('rate_limit', `Gmail throttled (${code}): ${e.message}`, code);
    }
    if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKET' || e.code === 'ECONNECTION') {
      throw new TransportError('network', `Gmail connection failure: ${e.message}`);
    }
    throw new TransportError(code >= 500 ? 'server' : 'validation', `Gmail: ${e.message}`, code || undefined);
  }
}
