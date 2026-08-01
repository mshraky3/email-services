import { ensureSchema, query } from '@/lib/db.ts';
import { suppress } from '@/lib/suppression.ts';
import { verifyToken } from '@/lib/unsubscribe.ts';
import { guard } from '@/lib/route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One-click unsubscribe.
 *
 * Public by necessity — it is clicked from a mail client — but the token is an
 * HMAC, so links cannot be guessed or enumerated.
 *
 * POST must act WITHOUT a confirmation step: that is what Gmail and Yahoo
 * require for `List-Unsubscribe-Post`, and a provider that finds the one-click
 * header does not work will start treating the mail as spam.
 */

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
     <body style="margin:0;font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#f1f5f9;
                  display:flex;align-items:center;justify-content:center;min-height:100vh;">
       <div style="background:#fff;padding:40px;border-radius:14px;max-width:460px;text-align:center;">
         <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">${title}</h1>
         <p style="margin:0;color:#475569;font-size:15px;line-height:1.7;">${body}</p>
       </div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function apply(token: string): Promise<boolean> {
  const result = verifyToken(token);
  if (!result.valid) return false;

  if ('legacy' in result) {
    // A token minted by MEDQIZE before the gateway existed. It identifies an
    // ACCOUNT ID, not an email address, and only MEDQIZE's own database can
    // resolve that — so the authoritative opt-out stays there. MEDQIZE's
    // /api/unsubscribe endpoint remains deployed permanently for exactly this
    // reason, and forwards the resolved address to /api/admin/suppress.
    //
    // All this endpoint can do is honour a valid signature so the person
    // clicking a link already sitting in their inbox gets a confirmation
    // rather than an error.
    await query(
      `INSERT INTO message_events (event_type, raw) VALUES ('gateway.legacy_unsubscribe', $1)`,
      [JSON.stringify({ accountId: result.accountId, at: new Date().toISOString() })],
    ).catch(() => {});
    return true;
  }

  await suppress(result.payload.email, 'unsubscribe', {
    scope: result.payload.scope || 'global',
    note: `one-click from ${result.payload.project}`,
  });
  return true;
}

export const GET = guard(async (_req: Request, { params }: { params: { token: string } }) => {
  // Signature FIRST: a forged token must be rejected without any database work.
  if (!verifyToken(params.token).valid) {
    return page('رابط غير صالح', 'هذا الرابط غير صحيح أو منتهي الصلاحية.', 400);
  }
  await ensureSchema();
  const ok = await apply(params.token);
  return ok
    ? page('تم إلغاء الاشتراك', 'لن تصلك رسائل تسويقية بعد الآن. الرسائل الضرورية لحسابك — مثل رموز الدخول والفواتير — ستستمر.')
    : page('رابط غير صالح', 'هذا الرابط غير صحيح أو منتهي الصلاحية.', 400);
});

export const POST = guard(async (_req: Request, { params }: { params: { token: string } }) => {
  if (!verifyToken(params.token).valid) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  await ensureSchema();
  const ok = await apply(params.token);
  // One-click: no confirmation UI, just an immediate machine-readable result.
  // Gmail and Yahoo require this to act without an interstitial.
  return new Response(JSON.stringify({ ok }), {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
});
