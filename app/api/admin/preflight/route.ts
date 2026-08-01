import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { checkSecret } from '@/lib/auth.ts';
import { ensureSchema, one, query } from '@/lib/db.ts';
import * as gmail from '@/lib/transports/gmail.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/admin/preflight — deploy readiness of THIS running instance.
 *
 * `npm run preflight` checks your laptop's .env.local, which says nothing about
 * what the deployed gateway actually has. This reports the real thing: which
 * environment variables exist in production, whether the Resend key works,
 * whether Gmail authenticates, and what still has to be set.
 *
 * Validates credentials without sending: Resend via the read-only GET /domains,
 * Gmail via an SMTP handshake. No email, no quota.
 */
export const GET = guard(async (req: Request) => {
  if (!checkSecret(req, 'ADMIN_KEY')) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const env: Record<string, 'set' | 'MISSING'> = {};
  const required = ['DATABASE_URL', 'MAIL_DOMAIN', 'ADMIN_KEY', 'DRAIN_SECRET', 'UNSUB_SECRET'];
  const optional = [
    'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET',
    'GMAIL_SMTP_USER', 'GMAIL_SMTP_PASS', 'GMAIL_FROM_ADDRESS',
    'PUBLIC_BASE_URL', 'PRODUCTION_ORIGINS', 'LEGACY_UNSUB_SECRET',
  ];
  for (const k of [...required, ...optional]) env[k] = process.env[k] ? 'set' : 'MISSING';

  const blocking: string[] = required.filter((k) => !process.env[k]);
  const warnings: string[] = [];

  // ── database ──
  let db: Record<string, unknown> = { ok: false };
  try {
    await ensureSchema();
    const projects = await query<{ slug: string; events: number; keys: number; dry_run: boolean; origins: string[] }>(
      `SELECT p.slug, p.dry_run, p.production_origins AS origins,
              COUNT(n.id)::int AS events,
              (SELECT COUNT(*)::int FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL) AS keys
         FROM projects p LEFT JOIN notification_policies n ON n.project_id=p.id
        GROUP BY p.id ORDER BY p.slug`,
    );
    const version = await one<{ v: string }>(`SELECT v FROM schema_meta WHERE k='version'`);
    db = { ok: true, schema_version: version?.v, projects };
    for (const p of projects) {
      if (p.keys === 0) blocking.push(`project ${p.slug} has no API key`);
      if (!p.origins?.length) warnings.push(`project ${p.slug} has no production_origins — its mail will be dropped unless the host is in PRODUCTION_ORIGINS`);
    }
  } catch (err) {
    db = { ok: false, error: (err as Error).message };
    blocking.push('database unreachable');
  }

  // ── Resend: read-only, costs nothing ──
  let resend: Record<string, unknown> = { configured: false };
  if (!process.env.RESEND_API_KEY) {
    warnings.push('RESEND_API_KEY is not set — user-facing mail cannot be sent');
  } else {
    try {
      const res = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      });
      if (!res.ok) {
        resend = { configured: true, key_valid: false, http: res.status };
        blocking.push(`Resend rejected the API key (HTTP ${res.status})`);
      } else {
        const body = await res.json();
        const want = process.env.MAIL_DOMAIN;
        const match = (body?.data ?? []).find((d: { name: string }) => d.name === want);
        resend = {
          configured: true, key_valid: true, domain: want,
          domain_status: match?.status ?? 'NOT FOUND', region: match?.region,
        };
        if (!match) blocking.push(`${want} is not on this Resend account`);
        else if (match.status !== 'verified') blocking.push(`${want} is ${match.status}, not verified`);
      }
    } catch (err) {
      resend = { configured: true, error: (err as Error).message };
      warnings.push('could not reach api.resend.com');
    }
  }
  if (!process.env.RESEND_WEBHOOK_SECRET) {
    warnings.push('RESEND_WEBHOOK_SECRET is not set — bounces and complaints are NOT being recorded, so dead addresses keep getting mail and the shared domain reputation degrades');
  }

  // ── Gmail: SMTP handshake, sends nothing ──
  let gmailStatus: Record<string, unknown> = { configured: false };
  if (!gmail.isConfigured()) {
    warnings.push('Gmail is not configured — owner mail would fall back to Resend and eat the shared budget');
  } else {
    try {
      await gmail.verify();
      gmailStatus = { configured: true, authenticated: true, user: process.env.GMAIL_SMTP_USER?.replace(/^(.{3}).*(@.*)$/, '$1***$2') };
    } catch (err) {
      gmailStatus = { configured: true, authenticated: false, error: (err as Error).message };
      blocking.push('Gmail SMTP authentication failed');
    }
  }

  const dryRun = process.env.DRY_RUN === 'true';
  if (dryRun) warnings.push('DRY_RUN=true — the gateway is recording but NOT sending. Set it to false to go live.');

  return NextResponse.json({
    ok: blocking.length === 0,
    verdict: blocking.length === 0 ? (dryRun ? 'READY (still in dry run)' : 'LIVE') : 'NOT READY',
    dry_run: dryRun,
    env,
    database: db,
    resend,
    gmail: gmailStatus,
    blocking,
    warnings,
  });
});
