/**
 * HTML shell and central (Tier C) templates.
 *
 * Existing projects mostly do NOT use this — they pass fully rendered HTML
 * through (Tier A), which is what makes the migration a zero-template-change
 * cutover. This module serves new projects and the digest composer, so that an
 * `email.txt` reader never has to hand-write RTL Arabic email HTML.
 *
 * Email HTML rules that are non-negotiable here: table layout, inline styles,
 * no external CSS, no webfonts. Arabic gets a Tahoma-first stack because it is
 * the only Arabic-capable face reliably present in Outlook and Gmail's
 * renderers.
 */

import type { DigestItem, Severity } from './types.ts';

const AR_STACK = `'Segoe UI', Tahoma, Arial, sans-serif`;

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#dc2626',
  warn: '#d97706',
  info: '#2563eb',
};

export interface ShellOptions {
  dir?: 'rtl' | 'ltr';
  lang?: string;
  title?: string;
  footer?: string;
  unsubscribeUrl?: string | null;
}

export function shell(bodyHtml: string, opts: ShellOptions = {}): string {
  const dir = opts.dir ?? 'rtl';
  const lang = opts.lang ?? (dir === 'rtl' ? 'ar' : 'en');
  const align = dir === 'rtl' ? 'right' : 'left';

  const unsub = opts.unsubscribeUrl
    ? `<p style="margin:18px 0 0;font-size:12px;color:#94a3b8;text-align:${align};">
         <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">
           ${dir === 'rtl' ? 'إلغاء الاشتراك' : 'Unsubscribe'}
         </a>
       </p>`
    : '';

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title ?? '')}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;
                  font-family:${AR_STACK};direction:${dir};text-align:${align};">
      <tr><td style="padding:28px 28px 8px;">${bodyHtml}</td></tr>
      <tr><td style="padding:8px 28px 28px;border-top:1px solid #e2e8f0;">
        <p style="margin:14px 0 0;font-size:12px;color:#94a3b8;text-align:${align};">
          ${escapeHtml(opts.footer ?? '')}
        </p>
        ${unsub}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Tier C: one-time code. */
export function otpTemplate(data: { code: string; minutes?: number; appName?: string; dir?: 'rtl' | 'ltr' }) {
  const dir = data.dir ?? 'rtl';
  const ar = dir === 'rtl';
  const minutes = data.minutes ?? 5;
  const heading = ar ? 'رمز التحقق' : 'Your verification code';
  const note = ar ? `الرمز صالح لمدة ${minutes} دقائق.` : `This code is valid for ${minutes} minutes.`;
  const warn = ar ? 'إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.' : 'If you did not request this code, ignore this email.';

  const html = shell(
    `<h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">${escapeHtml(heading)}</h1>
     <p style="margin:0 0 20px;font-size:15px;color:#475569;">${escapeHtml(note)}</p>
     <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#0f172a;
                 background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;
                 padding:18px;text-align:center;direction:ltr;">${escapeHtml(data.code)}</div>
     <p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">${escapeHtml(warn)}</p>`,
    { dir, title: heading, footer: data.appName ?? '' },
  );

  return { html, text: `${heading}: ${data.code}\n${note}\n${warn}` };
}

/** Tier C: generic notice. */
export function noticeTemplate(data: {
  heading: string; body: string; dir?: 'rtl' | 'ltr';
  link?: { label: string; url: string }; appName?: string;
}) {
  const dir = data.dir ?? 'rtl';
  const cta = data.link
    ? `<p style="margin:24px 0 0;">
         <a href="${escapeHtml(data.link.url)}"
            style="display:inline-block;background:#2563eb;color:#fff;padding:12px 22px;
                   border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">
           ${escapeHtml(data.link.label)}</a></p>`
    : '';

  const html = shell(
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;">${escapeHtml(data.heading)}</h1>
     <div style="font-size:15px;color:#475569;line-height:1.7;white-space:pre-wrap;">${escapeHtml(data.body)}</div>
     ${cta}`,
    { dir, title: data.heading, footer: data.appName ?? '' },
  );

  const linkText = data.link ? `\n\n${data.link.label}: ${data.link.url}` : '';
  return { html, text: `${data.heading}\n\n${data.body}${linkText}` };
}

/**
 * Digest body.
 *
 * Grouped by project, then event type, sorted severity-first then oldest-first.
 * Each item gets its own `dir` so Arabic (HR-, MEDQIZE) and English (portfolio)
 * items coexist correctly inside one email — unavoidable once several projects
 * share the `owner:daily` key, and correct as long as the direction is islanded
 * per block rather than applied to the whole document.
 */
export interface DigestGroup {
  project: string;
  items: Array<{ item: DigestItem; occurrences: number; severity: Severity; eventType: string }>;
}

export function digestTemplate(groups: DigestGroup[], opts: { dir?: 'rtl' | 'ltr'; date?: string } = {}) {
  const dir = opts.dir ?? 'ltr';
  const total = groups.reduce((n, g) => n + g.items.reduce((m, i) => m + i.occurrences, 0), 0);
  const counts: Record<Severity, number> = { critical: 0, warn: 0, info: 0 };
  for (const g of groups) for (const i of g.items) counts[i.severity] += i.occurrences;

  const chip = (label: string, n: number, color: string) =>
    n > 0
      ? `<span style="display:inline-block;background:${color};color:#fff;border-radius:999px;
                      padding:3px 11px;font-size:12px;font-weight:600;margin-inline-end:6px;">
           ${label} ${n}</span>`
      : '';

  const renderItem = (entry: DigestGroup['items'][number]) => {
    const { item, occurrences, severity } = entry;
    const idir = item.dir ?? 'ltr';
    const times = occurrences > 1
      ? `<span style="color:${SEVERITY_COLOR[severity]};font-weight:700;">&times;${occurrences}</span>`
      : '';
    const fields = (item.fields ?? [])
      .map(
        (f) => `<div style="font-size:12px;color:#64748b;margin-top:3px;">
                  <strong style="color:#475569;">${escapeHtml(f.label)}:</strong> ${escapeHtml(f.value)}</div>`,
      )
      .join('');
    const link = item.link
      ? `<div style="margin-top:8px;"><a href="${escapeHtml(item.link.url)}"
           style="color:#2563eb;font-size:13px;font-weight:600;text-decoration:none;">
           ${escapeHtml(item.link.label)} &rsaquo;</a></div>`
      : '';

    return `<tr><td style="padding:12px 0;border-bottom:1px solid #f1f5f9;">
      <div dir="${idir}" style="text-align:${idir === 'rtl' ? 'right' : 'left'};
                  border-inline-start:3px solid ${SEVERITY_COLOR[severity]};padding-inline-start:12px;">
        <div style="font-size:14px;font-weight:700;color:#0f172a;">${escapeHtml(item.title)} ${times}</div>
        ${item.summary ? `<div style="font-size:13px;color:#475569;margin-top:4px;">${escapeHtml(item.summary)}</div>` : ''}
        ${fields}${link}
      </div></td></tr>`;
  };

  const rank: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
  const body = groups
    .map((g) => {
      const rows = [...g.items]
        .sort((a, b) => rank[a.severity] - rank[b.severity])
        .map(renderItem)
        .join('');
      const n = g.items.reduce((m, i) => m + i.occurrences, 0);
      return `<h2 style="margin:26px 0 6px;font-size:14px;color:#64748b;text-transform:uppercase;
                          letter-spacing:.6px;border-bottom:2px solid #e2e8f0;padding-bottom:6px;">
                ${escapeHtml(g.project)} <span style="color:#94a3b8;">(${n})</span></h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
    })
    .join('');

  const heading = `${total} event${total === 1 ? '' : 's'} across ${groups.length} project${groups.length === 1 ? '' : 's'}`;
  const html = shell(
    `<h1 style="margin:0 0 12px;font-size:19px;color:#0f172a;">${escapeHtml(heading)}</h1>
     <div style="margin-bottom:4px;">
       ${chip('critical', counts.critical, SEVERITY_COLOR.critical)}
       ${chip('warn', counts.warn, SEVERITY_COLOR.warn)}
       ${chip('info', counts.info, SEVERITY_COLOR.info)}
     </div>
     ${body}`,
    { dir, title: heading, footer: opts.date ?? '' },
  );

  const text = groups
    .map((g) => `== ${g.project} ==\n` +
      g.items.map((i) => `- ${i.item.title}${i.occurrences > 1 ? ` x${i.occurrences}` : ''}` +
        (i.item.summary ? `\n  ${i.item.summary}` : '') +
        (i.item.link ? `\n  ${i.item.link.url}` : '')).join('\n'))
    .join('\n\n');

  return { html, text: `${heading}\n\n${text}`, subject: `[Digest] ${heading}` };
}
