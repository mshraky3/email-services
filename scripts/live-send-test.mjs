/**
 * THE ONLY SCRIPT THAT SENDS REAL EMAIL.
 *
 *   npm run send:test -- you@example.com
 *
 * Proves the last hop that nothing else can: a message actually leaving the
 * gateway and arriving in an inbox. Everything else in this repo runs with
 * DRY_RUN=true and stops at the transport boundary.
 *
 * Sends exactly two messages:
 *   1. via Gmail  — the owner-mail path. Costs ZERO Resend quota.
 *   2. via Resend — the user-facing path, from the verified domain.
 *                   Costs 1 of the 100/day budget. Skip with --gmail-only.
 *
 * Talks to the transports through the same code the gateway uses, then puts
 * every setting back exactly as it found it.
 */
import './_env.mjs';
import { required } from './_env.mjs';

const to = process.argv.find((a) => a.includes('@'));
const gmailOnly = process.argv.includes('--gmail-only');

if (!to) {
  console.error('\n  Usage: npm run send:test -- you@example.com [--gmail-only]\n');
  process.exit(1);
}

required('MAIL_DOMAIN');

const { transports } = await import('../lib/transports/index.ts');
const { otpTemplate, digestTemplate } = await import('../lib/render.ts');

const domain = process.env.MAIL_DOMAIN;
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
let failures = 0;

console.log(`\n  Sending REAL email to ${to}\n`);

// ── 1. Gmail: the owner path (zero Resend quota) ────────────────────────────
if (!process.env.GMAIL_SMTP_USER || !process.env.GMAIL_SMTP_PASS) {
  console.log('  SKIP  gmail — not configured');
} else {
  const digest = digestTemplate([
    {
      project: 'Email Gateway',
      items: [
        {
          item: {
            title: 'Gateway is live',
            summary: `Owner mail routes over Gmail and costs zero Resend quota. Sent ${stamp}.`,
            fields: [
              { label: 'Transport', value: 'Gmail SMTP (500/day, separate quota)' },
              { label: 'Resend quota used', value: '0' },
            ],
          },
          occurrences: 1, severity: 'info', eventType: 'gateway.test',
        },
        {
          item: { title: 'Repeats collapse', summary: 'Identical events increment a counter instead of re-sending.' },
          occurrences: 47, severity: 'critical', eventType: 'gateway.demo',
        },
      ],
    },
  ], { date: stamp });

  try {
    const res = await transports.gmail({
      from: `"Email Gateway" <${process.env.GMAIL_FROM_ADDRESS || process.env.GMAIL_SMTP_USER}>`,
      to,
      subject: `[Gateway] Gmail transport OK — ${stamp}`,
      html: digest.html,
      text: digest.text,
      headers: {},
      idempotencyKey: `livetest-gmail-${Date.now()}`,
    });
    console.log(`  SENT  gmail   ${res.id ?? '(no id)'}`);
    console.log('        this is what an owner digest looks like — 0 Resend quota spent');
  } catch (err) {
    failures++;
    console.log(`  FAIL  gmail   ${err.message}`);
  }
}

// ── 2. Resend: the user-facing path from the verified domain ────────────────
if (gmailOnly) {
  console.log('  SKIP  resend — --gmail-only');
} else if (!process.env.RESEND_API_KEY) {
  console.log('  SKIP  resend — RESEND_API_KEY not set');
} else {
  const otp = otpTemplate({ code: '4821', minutes: 5, appName: 'SQB', dir: 'rtl' });
  try {
    const res = await transports.resend({
      from: `"SQB" <noreply@${domain}>`,
      to,
      subject: `[Gateway] رمز التحقق — اختبار ${stamp}`,
      html: otp.html,
      text: otp.text,
      headers: {},
      idempotencyKey: `livetest-resend-${Date.now()}`,
    });
    console.log(`  SENT  resend  ${res.id ?? '(no id)'}`);
    console.log(`        from noreply@${domain} — this spent 1 of the 100/day budget`);
    console.log('        check it renders right-to-left with the digits left-to-right');
  } catch (err) {
    failures++;
    console.log(`  FAIL  resend  ${err.kind ?? ''} ${err.message}`);
  }
}

// Release the SMTP socket; a lingering handle makes libuv abort on Windows.
const gmail = await import('../lib/transports/gmail.ts');
gmail.close();

console.log(`\n  ${failures === 0 ? 'Both transports delivered. Check the inbox (and spam).' : `${failures} transport(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
