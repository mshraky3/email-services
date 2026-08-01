import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { checkSecret, mintKey } from '@/lib/auth.ts';
import { ensureSchema, one, query } from '@/lib/db.ts';
import { suppress, unsuppress } from '@/lib/suppression.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin operations, gated by ADMIN_KEY.
 *
 * POST /api/admin  { action, ... }
 *
 * Actions:
 *   create_project   register a project and mint its first key (key shown ONCE)
 *   rotate_key       mint a new key; old ones keep working until revoked
 *   revoke_key       revoke by prefix
 *   set_policy       upsert a notification_policies row
 *   set_setting      change a quota_settings value (no redeploy needed)
 *   set_class        change a quota_policy reserve/ceiling
 *   suppress         manually add to the suppression list
 *   unsuppress       recover a wrongly-suppressed address
 *   retry            put a dead/failed message back in the queue
 */
export const POST = guard(async (req: Request) => {
  if (!checkSecret(req, 'ADMIN_KEY')) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  await ensureSchema();

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  switch (body.action) {
    case 'create_project': {
      const { slug, display_name, from_local_part, default_from_name } = body;
      if (!slug || !display_name || !from_local_part || !default_from_name) {
        return NextResponse.json(
          { ok: false, error: 'slug, display_name, from_local_part and default_from_name are required' },
          { status: 400 },
        );
      }
      const project = await one<{ id: number }>(
        `INSERT INTO projects (slug, display_name, from_local_part, default_from_name, reply_to,
                               default_locale, default_dir, best_priority, daily_max, monthly_max,
                               allowed_transports, dry_run)
         VALUES ($1,$2,$3,$4,$5,
                 COALESCE($6,'ar'), COALESCE($7,'rtl'), COALESCE($8,1),
                 COALESCE($9,60), COALESCE($10,1500),
                 COALESCE($11,'{resend,gmail}'), COALESCE($12,TRUE))
         ON CONFLICT (slug) DO UPDATE SET
           display_name=EXCLUDED.display_name, from_local_part=EXCLUDED.from_local_part,
           default_from_name=EXCLUDED.default_from_name, reply_to=EXCLUDED.reply_to
         RETURNING id`,
        [slug, display_name, from_local_part, default_from_name, body.reply_to ?? null,
         body.default_locale, body.default_dir, body.best_priority,
         body.daily_max, body.monthly_max, body.allowed_transports, body.dry_run],
      );
      const key = mintKey(slug);
      await query(
        `INSERT INTO api_keys (project_id, key_prefix, key_hash, label) VALUES ($1,$2,$3,$4)`,
        [project!.id, key.prefix, key.hash, body.key_label ?? 'initial'],
      );
      // The only time the full key is ever visible.
      return NextResponse.json({ ok: true, project_id: project!.id, api_key: key.key, key_prefix: key.prefix });
    }

    case 'rotate_key': {
      const project = await one<{ id: number; slug: string }>(`SELECT id, slug FROM projects WHERE slug=$1`, [body.slug]);
      if (!project) return NextResponse.json({ ok: false, error: 'unknown project' }, { status: 404 });
      const key = mintKey(project.slug);
      await query(`INSERT INTO api_keys (project_id, key_prefix, key_hash, label) VALUES ($1,$2,$3,$4)`,
        [project.id, key.prefix, key.hash, body.key_label ?? 'rotated']);
      // Deliberately does NOT revoke the old key: rotate, deploy, then revoke.
      return NextResponse.json({ ok: true, api_key: key.key, key_prefix: key.prefix, note: 'old keys still active — revoke separately once deployed' });
    }

    case 'revoke_key':
      await query(`UPDATE api_keys SET revoked_at=NOW() WHERE key_prefix=$1 AND revoked_at IS NULL`, [body.key_prefix]);
      return NextResponse.json({ ok: true });

    case 'set_policy': {
      const project = await one<{ id: number }>(`SELECT id FROM projects WHERE slug=$1`, [body.slug]);
      if (!project) return NextResponse.json({ ok: false, error: 'unknown project' }, { status: 404 });
      await query(
        `INSERT INTO notification_policies
           (project_id, event_type, priority, audience, delivery_mode, digest_key_template,
            dedupe_key_template, flush_threshold, escalate_when, escalated_priority,
            transport_hint, ttl_seconds, honors_unsubscribe)
         VALUES ($1,$2,$3,COALESCE($4,'user'),COALESCE($5,'immediate'),$6,$7,
                 COALESCE($8,25),$9,$10,$11,$12,COALESCE($13,TRUE))
         ON CONFLICT (project_id, event_type) DO UPDATE SET
           priority=EXCLUDED.priority, audience=EXCLUDED.audience,
           delivery_mode=EXCLUDED.delivery_mode, digest_key_template=EXCLUDED.digest_key_template,
           dedupe_key_template=EXCLUDED.dedupe_key_template, flush_threshold=EXCLUDED.flush_threshold,
           escalate_when=EXCLUDED.escalate_when, escalated_priority=EXCLUDED.escalated_priority,
           transport_hint=EXCLUDED.transport_hint, ttl_seconds=EXCLUDED.ttl_seconds,
           honors_unsubscribe=EXCLUDED.honors_unsubscribe`,
        [project.id, body.event_type, body.priority, body.audience, body.delivery_mode,
         body.digest_key_template ?? null, body.dedupe_key_template ?? null, body.flush_threshold,
         body.escalate_when ? JSON.stringify(body.escalate_when) : null, body.escalated_priority ?? null,
         body.transport_hint ?? null, body.ttl_seconds ?? null, body.honors_unsubscribe],
      );
      return NextResponse.json({ ok: true });
    }

    case 'set_setting':
      await query(`INSERT INTO quota_settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`,
        [body.key, String(body.value)]);
      return NextResponse.json({ ok: true });

    case 'set_class':
      await query(`UPDATE quota_policy SET reserve=COALESCE($2,reserve), ceiling=COALESCE($3,ceiling) WHERE priority=$1`,
        [body.priority, body.reserve ?? null, body.ceiling ?? null]);
      return NextResponse.json({ ok: true });

    case 'suppress':
      await suppress(body.email, body.reason ?? 'manual', { scope: body.scope, note: body.note });
      return NextResponse.json({ ok: true });

    case 'unsuppress':
      await unsuppress(body.email, body.scope ?? 'global');
      return NextResponse.json({ ok: true });

    case 'retry':
      await query(
        `UPDATE messages
            SET status='queued', claimed_at=NULL, attempts=0, scheduled_at=NOW(),
                expires_at = GREATEST(expires_at, NOW() + INTERVAL '1 day'), last_error=NULL
          WHERE id=$1 AND status IN ('dead','failed','expired')`,
        [body.id],
      );
      return NextResponse.json({ ok: true });

    default:
      return NextResponse.json({ ok: false, error: `unknown action: ${body.action}` }, { status: 400 });
  }
});
