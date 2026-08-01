'use client';

import { useEffect, useState } from 'react';

/**
 * Test-send page.
 *
 * Sends a REAL email on demand, bypassing DRY_RUN — a test page that respects
 * dry-run cannot answer the only question it exists for.
 *
 * Defaults to Resend because that is the real delivery path: it is the only
 * sender with the verified domain. Gmail is offered only to exercise the
 * overflow valve that takes over when the daily budget is gone.
 *
 * The admin key is kept in sessionStorage only: it lives for the tab and is
 * never written to disk or into a URL.
 */

const CARD: React.CSSProperties = {
  background: '#151b33',
  border: '1px solid #232b4d',
  borderRadius: 12,
  padding: 20,
};

const LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#94a3b8',
  textTransform: 'uppercase',
  letterSpacing: '.5px',
  marginBottom: 6,
};

const INPUT: React.CSSProperties = {
  width: '100%',
  background: '#0b1021',
  border: '1px solid #2b355c',
  borderRadius: 8,
  color: '#e2e8f0',
  padding: '10px 12px',
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const SAMPLES = [
  { id: 'notice_ar', label: 'Notice (Arabic, RTL)', hint: 'The generic template new projects use' },
  { id: 'otp', label: 'OTP code', hint: 'RTL body, digits forced left-to-right' },
  { id: 'digest', label: 'Owner digest', hint: 'What your 2/day bundled email looks like' },
  { id: 'notice_en', label: 'Notice (English, LTR)', hint: 'For portfolio-style mail' },
  { id: 'custom', label: 'Custom HTML', hint: 'Paste your own body' },
];

export default function TestPage() {
  const [adminKey, setAdminKey] = useState('');
  const [to, setTo] = useState('');
  const [slug, setSlug] = useState('medqize');
  const [transport, setTransport] = useState<'gmail' | 'resend'>('resend');
  const [sample, setSample] = useState('notice_ar');
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('<h2>مرحبا</h2>\n<p>رسالة اختبار.</p>');
  const [dir, setDir] = useState<'rtl' | 'ltr'>('rtl');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    setAdminKey(sessionStorage.getItem('gw_admin_key') ?? '');
    setTo(localStorage.getItem('gw_test_to') ?? '');
  }, []);

  async function send() {
    setBusy(true);
    setResult(null);
    sessionStorage.setItem('gw_admin_key', adminKey);
    localStorage.setItem('gw_test_to', to);
    try {
      const res = await fetch('/api/admin/test-send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, slug, transport, sample, subject, html, dir }),
      });
      setResult({ http: res.status, ...(await res.json().catch(() => ({}))) });
    } catch (err) {
      setResult({ ok: false, error: String((err as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  const ready = adminKey.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);

  return (
    <main style={{ padding: '32px 24px', maxWidth: 820, margin: '0 auto' }}>
      <a href="/" style={{ color: '#64748b', fontSize: 13, textDecoration: 'none' }}>&larr; dashboard</a>
      <h1 style={{ fontSize: 22, margin: '10px 0 4px' }}>Send a test email</h1>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 0, lineHeight: 1.7 }}>
        Sends for real, even while the gateway is in <code>DRY_RUN</code> — otherwise it could not
        tell you whether mail actually arrives. <strong>Resend</strong> is the real delivery path and
        the one worth testing; it spends 1 of the 100/day budget. <strong>Gmail</strong> is only the
        overflow valve for when that budget runs out, and is free but far more likely to land in spam.
      </p>

      <div style={{ ...CARD, marginTop: 20 }}>
        <label style={LABEL}>Admin key</label>
        <input
          type="password" style={INPUT} value={adminKey} placeholder="ADMIN_KEY"
          onChange={(e) => setAdminKey(e.target.value)}
        />
        <p style={{ fontSize: 11, color: '#64748b', margin: '6px 0 0' }}>
          Kept in this tab only (sessionStorage). Never stored on disk or put in a URL.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14, marginTop: 18 }}>
          <div>
            <label style={LABEL}>Send to</label>
            <input style={INPUT} value={to} placeholder="you@example.com"
                   onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label style={LABEL}>Send as</label>
            <select style={INPUT} value={slug} onChange={(e) => setSlug(e.target.value)}>
              <option value="medqize">SQB — noreply@</option>
              <option value="hr">HR system — hr@</option>
              <option value="portfolio">Portfolio — contact@</option>
              <option value="game">Te3rafni — play@</option>
            </select>
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <label style={LABEL}>Transport</label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {([
              ['resend', 'Resend', 'the real path — spends 1 of 100/day'],
              ['gmail', 'Gmail', 'overflow only — free, but lands in spam'],
            ] as const).map(([id, label, hint]) => (
              <button
                key={id} type="button" onClick={() => setTransport(id)}
                style={{
                  flex: '1 1 180px', textAlign: 'left', cursor: 'pointer',
                  background: transport === id ? '#1d2a52' : '#0b1021',
                  border: `1px solid ${transport === id ? '#3b82f6' : '#2b355c'}`,
                  borderRadius: 8, padding: '10px 14px', color: '#e2e8f0', fontFamily: 'inherit',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
                <div style={{ fontSize: 11, color: transport === id ? '#93c5fd' : '#64748b' }}>{hint}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <label style={LABEL}>Template</label>
          <select style={INPUT} value={sample} onChange={(e) => setSample(e.target.value)}>
            {SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <p style={{ fontSize: 11, color: '#64748b', margin: '6px 0 0' }}>
            {SAMPLES.find((s) => s.id === sample)?.hint}
          </p>
        </div>

        {sample === 'custom' && (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 12 }}>
              <div>
                <label style={LABEL}>Subject</label>
                <input style={INPUT} value={subject} placeholder="Test message"
                       onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div>
                <label style={LABEL}>Direction</label>
                <select style={INPUT} value={dir} onChange={(e) => setDir(e.target.value as 'rtl' | 'ltr')}>
                  <option value="rtl">RTL</option>
                  <option value="ltr">LTR</option>
                </select>
              </div>
            </div>
            <label style={{ ...LABEL, marginTop: 14 }}>HTML body</label>
            <textarea
              style={{ ...INPUT, minHeight: 130, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 }}
              value={html} onChange={(e) => setHtml(e.target.value)}
            />
            <p style={{ fontSize: 11, color: '#64748b', margin: '6px 0 0' }}>
              Wrapped in the standard shell, so you only write the inner content.
            </p>
          </div>
        )}

        <button
          type="button" onClick={send} disabled={!ready || busy}
          style={{
            marginTop: 22, width: '100%', padding: '13px', borderRadius: 9, border: 'none',
            fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
            cursor: ready && !busy ? 'pointer' : 'not-allowed',
            background: ready && !busy ? (transport === 'resend' ? '#b45309' : '#2563eb') : '#1e2544',
            color: ready && !busy ? '#fff' : '#64748b',
          }}
        >
          {busy ? 'Sending…' : transport === 'resend' ? 'Send via Resend (costs 1)' : 'Send via Gmail (free)'}
        </button>
      </div>

      {result && (
        <div style={{ ...CARD, marginTop: 16, borderColor: result.ok ? '#166534' : '#7f1d1d' }}>
          <div style={{ fontWeight: 700, color: result.ok ? '#22c55e' : '#f87171', fontSize: 15 }}>
            {result.ok ? 'Sent — check your inbox (and spam)' : `Failed (HTTP ${result.http})`}
          </div>
          {result.ok ? (
            <table style={{ marginTop: 12, fontSize: 13, borderCollapse: 'collapse' }}>
              <tbody>
                {[
                  ['From', result.from],
                  ['To', result.to],
                  ['Subject', result.subject],
                  ['Transport', result.transport],
                  ['Provider id', result.provider_id ?? '—'],
                  ['Cost', result.cost],
                  ['Budget', `${result.quota?.daily_used} / ${result.quota?.daily_ceiling} today`],
                ].map(([k, v]) => (
                  <tr key={k as string}>
                    <td style={{ color: '#94a3b8', padding: '3px 16px 3px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}>{k}</td>
                    <td style={{ padding: '3px 0', wordBreak: 'break-all' }}>{v as string}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.7, marginBottom: 0 }}>
              {result.error}
              {result.http === 401 && ' — check the admin key.'}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
