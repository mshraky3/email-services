import { ensureSchema, one, query } from '@/lib/db.ts';
import { DEFAULT_DAILY_BUDGET, evaluate } from '@/lib/quota.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CARD: React.CSSProperties = {
  background: '#151b33',
  border: '1px solid #232b4d',
  borderRadius: 12,
  padding: '18px 20px',
};

const STATUS_COLOR: Record<string, string> = {
  sent: '#22c55e',
  sending: '#eab308',
  failed: '#ef4444',
  dropped: '#64748b',
  suppressed: '#a855f7',
  throttled: '#38bdf8',
};

function Bar({ used, total, color }: { used: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div style={{ background: '#0b1021', borderRadius: 999, height: 8, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color }} />
    </div>
  );
}

export default async function Dashboard() {
  let error: string | null = null;
  let recent: any[] = [];
  let byStatus: any[] = [];
  let byProject: any[] = [];
  let stats: any = null;
  let budget = DEFAULT_DAILY_BUDGET;

  try {
    await ensureSchema();
    const [s, b, r, st, bp] = await Promise.all([
      one<{ resend_24h: string; sent_24h: string; failed: string; retrying: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE transport='resend' AND status IN ('sent','sending')
                              AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '24 hours')::text AS resend_24h,
           COUNT(*) FILTER (WHERE status='sent' AND created_at > NOW() - INTERVAL '24 hours')::text AS sent_24h,
           COUNT(*) FILTER (WHERE status='failed' AND created_at > NOW() - INTERVAL '24 hours')::text AS failed,
           COUNT(*) FILTER (WHERE status='failed' AND retry_after IS NOT NULL)::text AS retrying
         FROM messages`,
      ),
      one<{ v: string }>(`SELECT v FROM quota_settings WHERE k='daily_budget'`),
      query(
        `SELECT m.id, p.slug, m.event_type, m.to_address, m.status, m.status_reason,
                m.transport, m.severity, m.created_at
           FROM messages m JOIN projects p ON p.id = m.project_id
          ORDER BY m.created_at DESC LIMIT 25`,
      ),
      query(
        `SELECT status, COUNT(*)::text AS n FROM messages
          WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status ORDER BY 2 DESC`,
      ),
      query(
        `SELECT p.slug, COUNT(m.id)::text AS n,
                COUNT(m.id) FILTER (WHERE m.transport='resend' AND m.status='sent')::text AS resend
           FROM projects p LEFT JOIN messages m
             ON m.project_id = p.id AND m.created_at > NOW() - INTERVAL '24 hours'
          GROUP BY p.slug ORDER BY p.slug`,
      ),
    ]);
    stats = s; recent = r; byStatus = st; byProject = bp;
    budget = Number(b?.v ?? DEFAULT_DAILY_BUDGET);
  } catch (err) {
    error = (err as Error).message;
  }

  if (error) {
    return (
      <main style={{ padding: 40, maxWidth: 800, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22 }}>Email Gateway</h1>
        <div style={{ ...CARD, borderColor: '#7f1d1d', marginTop: 20 }}>
          <strong style={{ color: '#f87171' }}>Not connected</strong>
          <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.7 }}>{error}</p>
          <p style={{ color: '#64748b', fontSize: 13 }}>
            Set <code>DATABASE_URL</code>, then run <code>npm run db:init</code>.
          </p>
        </div>
      </main>
    );
  }

  const used = Number(stats?.resend_24h ?? 0);
  const q = evaluate({ usedToday: used, budget });
  const pct = (used / budget) * 100;

  return (
    <main style={{ padding: '32px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Email Gateway</h1>
        {process.env.DRY_RUN === 'true' && (
          <span style={{ background: '#eab308', color: '#0b1021', borderRadius: 999, padding: '3px 12px', fontSize: 12, fontWeight: 700 }}>
            DRY RUN — nothing is being sent
          </span>
        )}
        <a href="/test" style={{
          marginInlineStart: 'auto', background: '#1d2a52', border: '1px solid #3b82f6',
          color: '#93c5fd', borderRadius: 8, padding: '7px 14px', fontSize: 13,
          fontWeight: 600, textDecoration: 'none',
        }}>
          Send a test email
        </a>
      </header>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 0 }}>
        Mail is sent immediately on arrival — no queue, no scheduler. When the Resend budget
        is spent, sending continues over Gmail.
      </p>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14, marginTop: 22 }}>
        <div style={CARD}>
          <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px' }}>
            Resend, last 24h
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>
            {used} <span style={{ color: '#64748b', fontSize: 16 }}>/ {budget}</span>
          </div>
          <Bar used={used} total={budget} color={pct > 85 ? '#ef4444' : pct > 70 ? '#eab308' : '#22c55e'} />
          <div style={{ fontSize: 12, color: q.resendAvailable ? '#64748b' : '#eab308', marginTop: 8 }}>
            {q.resendAvailable
              ? `${q.remaining} left before Gmail takes over`
              : 'budget spent — sending over Gmail'}
          </div>
        </div>

        <div style={CARD}>
          <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px' }}>
            Delivered, last 24h
          </div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4, color: '#22c55e' }}>
            {stats?.sent_24h ?? 0}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
            across every project and transport
          </div>
        </div>

        <div style={CARD}>
          <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px' }}>
            Awaiting retry
          </div>
          <div style={{
            fontSize: 26, fontWeight: 700, marginTop: 4,
            color: Number(stats?.retrying ?? 0) > 0 ? '#ef4444' : '#e2e8f0',
          }}>
            {stats?.retrying ?? 0}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 8 }}>
            {Number(stats?.retrying ?? 0) > 0
              ? 'retried by the next inbound request'
              : `${stats?.failed ?? 0} failed in 24h`}
          </div>
        </div>
      </section>

      {byProject.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.6px', marginTop: 34 }}>
            By project, last 24h
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {byProject.map((p: any) => (
              <span key={p.slug} style={{ ...CARD, padding: '10px 16px', fontSize: 13 }}>
                <strong>{p.slug}</strong>{' '}
                <span style={{ color: '#94a3b8' }}>{p.n} messages</span>
                <span style={{ color: '#64748b' }}> · {p.resend} on Resend</span>
              </span>
            ))}
          </div>
        </>
      )}

      {byStatus.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.6px', marginTop: 30 }}>
            Outcomes, last 24h
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {byStatus.map((s: any) => (
              <span key={s.status} style={{ ...CARD, padding: '8px 14px', fontSize: 13 }}>
                <span style={{ color: STATUS_COLOR[s.status] ?? '#94a3b8', fontWeight: 700 }}>{s.n}</span>{' '}
                <span style={{ color: '#94a3b8' }}>{s.status}</span>
              </span>
            ))}
          </div>
        </>
      )}

      <h2 style={{ fontSize: 14, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.6px', marginTop: 34 }}>
        Recent messages
      </h2>
      <div style={{ ...CARD, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 720 }}>
          <thead>
            <tr style={{ background: '#1b2340', color: '#94a3b8', fontSize: 12, textAlign: 'left' }}>
              <th style={{ padding: '10px 16px' }}>Project</th>
              <th style={{ padding: '10px 16px' }}>Event</th>
              <th style={{ padding: '10px 16px' }}>To</th>
              <th style={{ padding: '10px 16px' }}>Status</th>
              <th style={{ padding: '10px 16px' }}>Via</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 24, color: '#64748b', textAlign: 'center' }}>
                No messages yet.
              </td></tr>
            )}
            {recent.map((m: any) => (
              <tr key={m.id} style={{ borderTop: '1px solid #232b4d' }}>
                <td style={{ padding: '9px 16px', color: '#94a3b8' }}>{m.slug}</td>
                <td style={{ padding: '9px 16px' }}>{m.event_type}</td>
                <td style={{ padding: '9px 16px', color: '#94a3b8' }}>{m.to_address}</td>
                <td style={{ padding: '9px 16px', color: STATUS_COLOR[m.status] ?? '#94a3b8', fontWeight: 600 }}>
                  {m.status}
                  {m.status_reason && (
                    <div style={{ color: '#64748b', fontWeight: 400, fontSize: 11 }}>{m.status_reason}</div>
                  )}
                </td>
                <td style={{ padding: '9px 16px', color: '#64748b' }}>{m.transport}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
