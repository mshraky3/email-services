# Go-live checklist

What remains, in order. Nothing breaks if you stop halfway.

Check the **running production instance** at any time:

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" https://email-services-nu.vercel.app/api/admin/preflight
```

---

## 1. Gateway env — one value left

Live preflight confirms every variable is set on Vercel and working: the Resend key is valid, `smle-question-bank.com` is verified, Gmail authenticates.

| Variable | Action |
|---|---|
| `RESEND_WEBHOOK_SECRET` | Set to `whsec_UI/PVvYEN7X5igCjdH09MAlb2mIrHlQr` and **redeploy**. It currently holds a placeholder, so real Resend events fail signature verification. |
| `DRY_RUN` | Set to `false` when you want the gateway to actually send. |
| `LEGACY_UNSUB_SECRET` | Optional. Only if you want unsubscribe links already sitting in old inboxes honoured by the gateway. |

## 2. Resend webhook

Resend dashboard → **Webhooks** → Add endpoint:

- URL: `https://email-services-nu.vercel.app/api/webhooks/resend`
- Events: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`

Without it, bounces and complaints go unrecorded and the gateway keeps mailing dead addresses — which degrades delivery for every project, since they share one domain.

Verified working with your real secret: signed → `200`, forged → `401`, a permanent bounce creates a suppression that blocks even OTP.

## 3. ~~Cron job~~ — not needed

**Nothing to schedule.** Mail sends immediately on arrival. If you already created the cron-job.org entry, delete it.

## 4. Push the four project repos

Code is updated locally but uncommitted. See `PROJECT-CHANGES.md` for file-by-file detail.

| Repo | What to commit |
|---|---|
| MEDQIZE | `backend/services/{mailer.js, email-client.js, errorNotificationService.js}`, `backend/app.js` |
| HR- | `express-app/utils/{emailService.js, email-client.js, errorNotificationService.js}` |
| portfolio | `backend/{api.js, email-client.js}` |
| game | `lib/{notify.ts, email-client.mjs}`, `app/api/messages/route.ts`, `.env.example` |

> **HR- has ~213 uncommitted files predating this work.** Check `git status` and commit selectively.

Then add these to each project's host (Vercel → Settings → Environment Variables) — `.env` is gitignored, so pushing code is not enough, and env changes need a redeploy.

```
EMAIL_GATEWAY_URL=https://email-services-nu.vercel.app
EMAIL_GATEWAY_MODE=shadow
EMAIL_GATEWAY_KEY=<the project's own key>
```

| Project | `EMAIL_GATEWAY_KEY` |
|---|---|
| MEDQIZE | `ek_live_medqize_rWy83-8tFnbmx5isJywbi8m68zgXaFkd` |
| HR- | `ek_live_hr_uq97D2jHazVaHgBKlhP3YWsPFW2wcTAV` |
| portfolio | `ek_live_portfolio_V6EOG1R_yNgIRYUjn4PQs29_3mgsugi1` |
| game | `ek_live_game_il3DzOhmVgh1T5ox-F7tk_LTuQ_eby0u` |

Never reuse one project's key in another — per-project caps and isolation depend on it.

## 5. Shadow, then cut over

On `shadow`, each project's existing mailer still sends and the gateway only records. Nothing user-facing changes.

Watch [the dashboard](https://email-services-nu.vercel.app) for a few days:

- Every legacy send should have one gateway record.
- Nothing unexpected showing `dropped` — if it is, that project's host is missing from its `production_origins`.
- How close daily volume actually gets to 95.

Then flip `EMAIL_GATEWAY_MODE=on` one project at a time: **portfolio → game → HR- → MEDQIZE**. Set `DRY_RUN=false` on the gateway when the first one flips.

Rollback is `EMAIL_GATEWAY_MODE=off` on that project. No code change.

## 6. After 30 days stable

1. Remove `SMTP_*` / `EMAIL_*` variables from all four projects.
2. **Rotate the Resend API key** — it has lived in MEDQIZE's and HR-'s repos.
3. Delete the legacy sender code paths, kept until then as the escape hatch.

---

## Testing whenever you want

[`/test`](https://email-services-nu.vercel.app/test) sends a real email on demand, even while `DRY_RUN=true`.
