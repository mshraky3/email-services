import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { checkSecret } from '@/lib/auth.ts';
import { ensureSchema, one, query } from '@/lib/db.ts';
import { transports } from '@/lib/transports/index.ts';
import { digestTemplate, noticeTemplate, otpTemplate, shell } from '@/lib/render.ts';
import { loadQuotaSnapshot } from '@/lib/queue.ts';
import { quotaReport } from '@/lib/quota.ts';
import type { ProjectRow, TransportName } from '@/lib/types.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/admin/test-send — the one path that sends for real on demand.
 *
 * Deliberately bypasses DRY_RUN. A test page that respects dry-run cannot tell
 * you whether mail actually arrives, which is the only question it exists to
 * answer. Everything else in the gateway still honours DRY_RUN.
 *
 * The send IS recorded in `messages`, so a Resend test costs quota and shows up
 * in the ledger like any other message. Gmail tests cost nothing.
 *
 * Gated by ADMIN_KEY.
 */

const SAMPLES = {
  otp: () => {
    const t = otpTemplate({ code: '4821', minutes: 5, appName: 'SQB', dir: 'rtl' });
    return { subject: 'رمز التحقق — اختبار', ...t };
  },
  notice_ar: () => {
    const t = noticeTemplate({
      heading: 'إشعار تجريبي',
      body: 'هذه رسالة اختبار من نظام البريد المركزي.\nإذا وصلتك بشكل صحيح فكل شيء يعمل.',
      link: { label: 'فتح لوحة التحكم', url: process.env.PUBLIC_BASE_URL ?? 'https://example.com' },
      appName: 'SQB', dir: 'rtl',
    });
    return { subject: 'إشعار تجريبي — اختبار', ...t };
  },
  notice_en: () => {
    const t = noticeTemplate({
      heading: 'Test notice',
      body: 'This is a test message from the central email system.\nIf it looks right, everything works.',
      link: { label: 'Open dashboard', url: process.env.PUBLIC_BASE_URL ?? 'https://example.com' },
      appName: 'Email Gateway', dir: 'ltr',
    });
    return { subject: 'Test notice', ...t };
  },
  digest: () => {
    const t = digestTemplate([
      {
        project: 'SQB',
        items: [
          { item: { title: 'DB connection refused', summary: 'ECONNREFUSED 10.0.0.5:5432' }, occurrences: 47, severity: 'critical', eventType: 'e' },
          { item: { title: 'رسالة تواصل', summary: 'أحمد يسأل عن السعر', dir: 'rtl' }, occurrences: 3, severity: 'info', eventType: 'c' },
        ],
      },
      {
        project: 'HR system',
        items: [{ item: { title: 'طلب جديد من فرع الرياض', dir: 'rtl' }, occurrences: 2, severity: 'warn', eventType: 'r' }],
      },
      {
        project: 'Portfolio',
        items: [{ item: { title: 'Resume downloaded', summary: '5 times today' }, occurrences: 5, severity: 'info', eventType: 'd' }],
      },
    ], { date: new Date().toISOString().slice(0, 10) });
    return { subject: t.subject, html: t.html, text: t.text };
  },
} as const;

export const POST = guard(async (req: Request) => {
  if (!checkSecret(req, 'ADMIN_KEY')) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  await ensureSchema();

  let body: {
    to?: string;
    slug?: string;
    transport?: TransportName;
    sample?: keyof typeof SAMPLES | 'custom';
    subject?: string;
    html?: string;
    dir?: 'rtl' | 'ltr';
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  const to = (body.to ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return NextResponse.json({ ok: false, error: 'a valid recipient is required' }, { status: 400 });
  }

  const project = await one<ProjectRow>(
    `SELECT * FROM projects WHERE slug = $1`,
    [body.slug ?? 'medqize'],
  );
  if (!project) return NextResponse.json({ ok: false, error: 'unknown project' }, { status: 404 });

  // Build the body.
  let subject: string;
  let html: string;
  let text: string | undefined;

  if (body.sample === 'custom') {
    subject = body.subject?.trim() || 'Test message';
    html = shell(body.html || '<p>Test</p>', { dir: body.dir ?? 'rtl', title: subject });
    text = undefined;
  } else {
    const build = SAMPLES[(body.sample ?? 'notice_ar') as keyof typeof SAMPLES] ?? SAMPLES.notice_ar;
    const out = build();
    subject = out.subject;
    html = out.html;
    text = 'text' in out ? out.text : undefined;
  }
  subject = `[TEST] ${subject}`;

  // Gmail unless Resend is explicitly asked for: a test should not quietly
  // spend the scarce budget.
  const transport: TransportName = body.transport ?? 'gmail';
  const domain = process.env.MAIL_DOMAIN || 'localhost';
  const fromAddress = `${project.from_local_part}@${domain}`;

  // Record before sending, so a send that succeeds but whose response is lost
  // is still counted against quota rather than silently free.
  const row = await one<{ id: string }>(
    `INSERT INTO messages
       (project_id, event_type, priority, audience, to_address, from_name, from_address,
        subject, html, text, locale, dir, status, transport, expires_at, source_origin)
     VALUES ($1,'gateway.test_send',2,'owner',$2,$3,$4,$5,$6,$7,$8,$9,'attempting',$10,
             NOW() + INTERVAL '1 hour','admin-test-page')
     RETURNING id`,
    [project.id, to, project.default_from_name, fromAddress, subject, html, text ?? null,
     project.default_locale, body.dir ?? project.default_dir, transport],
  );

  try {
    const res = await transports[transport]({
      from: `"${project.default_from_name}" <${fromAddress}>`,
      to,
      subject,
      html,
      text,
      headers: {},
      idempotencyKey: row!.id,
    });
    await query(`UPDATE messages SET status='sent', provider_id=$2, sent_at=NOW() WHERE id=$1`, [row!.id, res.id]);

    const snapshot = await loadQuotaSnapshot();
    const report = quotaReport(snapshot);

    return NextResponse.json({
      ok: true,
      id: row!.id,
      provider_id: res.id,
      transport,
      from: `"${project.default_from_name}" <${fromAddress}>`,
      to,
      subject,
      cost: transport === 'resend' ? '1 Resend email' : 'nothing — Gmail is a separate quota',
      quota: { daily_used: report.daily_used, daily_ceiling: report.daily_ceiling },
    });
  } catch (err) {
    const message = (err as Error).message ?? 'send failed';
    await query(`UPDATE messages SET status='failed', last_error=$2 WHERE id=$1`, [row!.id, message.slice(0, 500)]);
    return NextResponse.json({ ok: false, error: message, transport }, { status: 502 });
  }
});
