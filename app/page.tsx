import { ensureSchema, query, one } from '@/lib/db.ts';
import { loadQuotaSnapshot } from '@/lib/queue.ts';
import { quotaReport } from '@/lib/quota.ts';

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
  queued: '#38bdf8',
  claimed: '#38bdf8',
  attempting: '#eab308',
  dropped: '#64748b',
  suppressed: '#a855f7',
  expired: '#64748b',
  failed: '#f97316',
  dead: '#ef4444',
};

function Bar({ used, total, color }: { used: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div style={{ background: '#0b1021', borderRadius: 999, height: 8, overflow: 'hidden', marginTop: 6 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color }} />
    </div>
  );
}

export default async function Dashboard() {
  let error: string | null = null;
  let report: ReturnType<typeof quotaReport> | null = null;
  let recent: any[] = [];
  let queue: any = null;
  let byStatus: any[] = [];

  try {
    await ensureSchema();
    const snapshot = await loadQuotaSnapshot();
    report = quotaReport(snapshot);

    [recent, queue, byStatus] = await Promise.all([
      query(
        `SELECT m.id, p.slug, m.event_type, m.priority, m.to_address, m.subject,
                m.status, m.transport, m.created_at
           FROM messages m JOIN projects p ON p.id = m.project_id
          ORDER BY m.created_at DESC LIMIT 25`,
      ),
      one<{ pending: string; dead: string; oldest: string | null }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('queued','claimed'))::text AS pending,
                COUNT(*) FILTER (WHERE status='dead')::text AS dead,
                EXTRACT(EPOCH FROM (NOW() - MIN(scheduled_at) FILTER (WHERE status IN ('queued','claimed'))))::text AS oldest
           FROM messages`,
      ),
      query(
        `SELECT status, COUNT(*)::text AS n FROM messages
          WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY status ORDER BY 2 DESC`,
      ),
    ]);
  } catch (err) {
    error = (err as Error).message;
  }

  if (error) {
    return (
      <main style={{ padding: 40, maxWidth: 800, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22 }}>Email Gateway</h1>
        <div style={{ ...CARD, borderColor: '#7f1d1d', marginTop: 20 }}>
          <strong style={{ color: '#f87171' }}>Not connected</strong>
          <p style={{ color: '#94a3b8', fontSize: 14, lineHeight: 1.7 }}>
            {error}
          </p>
          <p style={{ color: '#64748b', fontSize: 13 }}>
            Set <code>DATABASE_URL</code> in <code>.env.local</code>, then run{' '}
            <code>npm run db:init</code>.
          </p>
        </div>
      </main>
    );
  }

  const dailyPct = report ? (report.daily_used / report.daily_ceiling) * 100 : 0;

  return (
    <main style={{ padding: '32px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Email Gateway</h1>
        {process.env.DRY_RUN === 'true' && (
          <span style={{ background: '#eab308', color: '#0b1021', borderRadius: 999, padding: '3px 12px', fontSize: 12, fontWeight: 700 }}>
            DRY RUN — nothing is being sent
          </span>
        )}
        <a
          href="/test"
          style={{
            marginInlineStart: 'auto', background: '#1d2a52', border: '1px solid #3b82f6',
            color: '#93c5fd', borderRadius: 8, padding: '7px 14px', fontSize: 13,
            fontWeight: 600, textDecoration: 'none',
          }}
        >
          Send a test email
        </a>
      </header>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 0 }}>
        Rolling 24h window. Only Resend sends are rationed — Gmail (owner mail) and dry-run sends are free.
      </p>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 14, marginTop: 22 }}>
        <div style={CARD}>
          <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px' }}>Daily budget</div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>
            {report?.daily_used} <span style={{ color: '#64748b', fontSize: 16 }}>/ {report?.daily_ceiling}</span>
          </div>
          <Bar used={report?.daily_used ?? 0} total={report?.daily_ceiling ?? 1}
               color={dailyPct > 85 ? '#ef4444' : dailyPct > 70 ? '#eab308' : '#22c55e'} />
        </div>
        <div style={CARD}>
          <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px' }}>Monthly</div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>
            {report?.monthly_used} <span style={{ color: '#64748b', fontSize: 16 }}>/ {report?.monthly_ceiling}</span>
          </div>
          <Bar used={report?.monthly_used ?? 0} total={report?.monthly_ceiling ?? 1} color="#38bdf8" />
        </div>
        <div style={CARD}>
          <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px' }}>Queue</div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>{queue?.pending ?? 0}</div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>
            oldest {Math.round(Number(queue?.oldest ?? 0) / 60)} min · {queue?.dead ?? 0} dead
          </div>
        </div>
      </section>

      <h2 style={{ fontSize: 14, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.6px', marginTop: 34 }}>
        Priority classes
      </h2>
      <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#1b2340', color: '#94a3b8', fontSize: 12, textAlign: 'left' }}>
              <th style={{ padding: '10px 16px' }}>Class</th>
              <th style={{ padding: '10px 16px' }}>Reserve</th>
              <th style={{ padding: '10px 16px' }}>Ceiling</th>
              <th style={{ padding: '10px 16px' }}>Effective</th>
              <th style={{ padding: '10px 16px' }}>Used</th>
              <th style={{ padding: '10px 16px' }}>Remaining</th>
            </tr>
          </thead>
          <tbody>
            {report?.by_priority.map((p) => (
              <tr key={p.priority} style={{ borderTop: '1px solid #232b4d' }}>
                <td style={{ padding: '10px 16px' }}>
                  <strong>P{p.priority}</strong> <span style={{ color: '#64748b' }}>{p.name}</span>
                </td>
                <td style={{ padding: '10px 16px', color: '#94a3b8' }}>
                  {p.effective_reserve}
                  {p.effective_reserve !== p.reserve && (
                    // Reserves are scaled down when the configured floors would
                    // not fit inside a reduced daily ceiling. Showing both makes
                    // that visible instead of looking like a config typo.
                    <span style={{ color: '#64748b', fontSize: 12 }}> (of {p.reserve})</span>
                  )}
                </td>
                <td style={{ padding: '10px 16px', color: '#94a3b8' }}>{p.ceiling}</td>
                <td style={{ padding: '10px 16px', color: p.effective_ceiling < p.ceiling ? '#eab308' : '#94a3b8' }}>
                  {p.effective_ceiling}
                </td>
                <td style={{ padding: '10px 16px' }}>{p.used}</td>
                <td style={{ padding: '10px 16px', color: p.remaining === 0 ? '#ef4444' : '#22c55e' }}>{p.remaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {byStatus.length > 0 && (
        <>
          <h2 style={{ fontSize: 14, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.6px', marginTop: 34 }}>
            Last 24h by status
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
              <th style={{ padding: '10px 16px' }}>P</th>
              <th style={{ padding: '10px 16px' }}>To</th>
              <th style={{ padding: '10px 16px' }}>Status</th>
              <th style={{ padding: '10px 16px' }}>Transport</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 24, color: '#64748b', textAlign: 'center' }}>
                No messages yet.
              </td></tr>
            )}
            {recent.map((m: any) => (
              <tr key={m.id} style={{ borderTop: '1px solid #232b4d' }}>
                <td style={{ padding: '9px 16px', color: '#94a3b8' }}>{m.slug}</td>
                <td style={{ padding: '9px 16px' }}>{m.event_type}</td>
                <td style={{ padding: '9px 16px', color: '#64748b' }}>{m.priority}</td>
                <td style={{ padding: '9px 16px', color: '#94a3b8' }}>{m.to_address}</td>
                <td style={{ padding: '9px 16px', color: STATUS_COLOR[m.status] ?? '#94a3b8', fontWeight: 600 }}>
                  {m.status}
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
