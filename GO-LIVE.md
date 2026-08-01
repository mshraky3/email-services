# Go-live checklist

Everything below is what remains. Ordered so nothing breaks if you stop halfway.

Check status at any time — this reports the **running production instance**, not your laptop:

```bash
curl -s -H "Authorization: Bearer $ADMIN_KEY" https://email-services-nu.vercel.app/api/admin/preflight
```

---

## 1. Gateway env — almost done

Live preflight says every variable is already set on Vercel. Only two things left:

| Variable | Status | Action |
|---|---|---|
| `RESEND_WEBHOOK_SECRET` | set, but it is **my generated placeholder** | Replace with Resend's real signing secret — step 2 |
| `DRY_RUN` | `true` | Set to `false` when you're ready to actually send — step 5 |
| `LEGACY_UNSUB_SECRET` | missing | Optional. Only set it (to SQB's `ADMIN_KEY`) if you want unsubscribe links already sitting in old inboxes to be honoured by the gateway |

Everything else — `DATABASE_URL`, `RESEND_API_KEY`, `MAIL_DOMAIN`, all three Gmail vars, `ADMIN_KEY`, `DRAIN_SECRET`, `UNSUB_SECRET`, `PUBLIC_BASE_URL`, `PRODUCTION_ORIGINS` — is confirmed present and working. The Resend key is valid and `smle-question-bank.com` is verified in `eu-west-1`. Gmail authenticates.

## 2. Create the Resend webhook — do not skip this

Resend dashboard → **Webhooks** → Add endpoint:

- URL: `https://email-services-nu.vercel.app/api/webhooks/resend`
- Events: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`

Copy the signing secret it gives you into `RESEND_WEBHOOK_SECRET` on Vercel and redeploy.

Until this is done, bounces and spam complaints are **not recorded**, so the gateway keeps mailing dead addresses. All four projects send from one domain and share one reputation, so that degrades delivery for everything.

## 3. Schedule the queue drain

Vercel Hobby crons run at most **once a day**, which is useless for a queue. Set up [cron-job.org](https://cron-job.org) (free):

- URL: `https://email-services-nu.vercel.app/api/v1/drain?source=cron-job-org`
- Method: **POST**, every **5 minutes**
- Header: `Authorization: Bearer <DRAIN_SECRET>`
- Turn on its failure notifications

Optional backup: add repo secrets `GATEWAY_URL` and `DRAIN_SECRET` to the email-services repo — `.github/workflows/drain.yml` is already committed and runs every 15 min.

A `{"skipped":"locked"}` response means another drain is already running. That is success.

## 4. Push the four project repos

Their code is updated locally but **nothing is committed**. See `PROJECT-CHANGES.md` for the file-by-file detail.

| Repo | What to commit |
|---|---|
| MEDQIZE | `backend/services/{mailer.js, email-client.js, errorNotificationService.js}`, `backend/app.js` |
| HR- | `express-app/utils/{emailService.js, email-client.js, errorNotificationService.js}` |
| portfolio | `backend/{api.js, email-client.js}` |
| game | `lib/{notify.ts, email-client.mjs}`, `app/api/messages/route.ts`, `.env.example` |

> **HR- has ~213 uncommitted files predating this work.** Check `git status` there and commit selectively so you don't sweep unrelated changes in.

Then add these to each project's host (Vercel → Settings → Environment Variables). `.env` is gitignored everywhere, so pushing the code is not enough — and env changes need a redeploy.

```
EMAIL_GATEWAY_URL=https://email-services-nu.vercel.app
EMAIL_GATEWAY_MODE=shadow
EMAIL_GATEWAY_KEY=<the project's own key, below>
```

| Project | `EMAIL_GATEWAY_KEY` |
|---|---|
| MEDQIZE | `ek_live_medqize_rWy83-8tFnbmx5isJywbi8m68zgXaFkd` |
| HR- | `ek_live_hr_uq97D2jHazVaHgBKlhP3YWsPFW2wcTAV` |
| portfolio | `ek_live_portfolio_V6EOG1R_yNgIRYUjn4PQs29_3mgsugi1` |
| game | `ek_live_game_il3DzOhmVgh1T5ox-F7tk_LTuQ_eby0u` |

Never reuse one project's key in another — that is how per-project caps and isolation work.

## 5. Shadow week, then cut over

With everything on `shadow`, each project's existing mailer still does the real sending and the gateway only records what it *would* have done. **Nothing user-facing changes.**

Watch [the dashboard](https://email-services-nu.vercel.app) for about a week. What you're looking for:

- Every legacy send has exactly one gateway record.
- Nothing unexpected showing `dropped` — if it is, that project's host is missing from its `production_origins`.
- How many would have been **deferred**, and at which priority. This is where you find out whether 100/day actually fits, before any user is affected.

Then, one at a time and riskiest last: **portfolio → game → HR- → MEDQIZE**.

For each: set `EMAIL_GATEWAY_MODE=on`, redeploy, watch for a day. Set `DRY_RUN=false` on the gateway when the first one flips.

Rollback is `EMAIL_GATEWAY_MODE=off` on that project. No code change, no gateway redeploy.

## 6. Raise the budget as you go

`daily_ceiling` is deliberately **40, not 95** — during migration both the projects and the gateway send, but the gateway only sees its own traffic, so it must leave room for what it cannot see. Raise it as each project cuts over:

```bash
curl -X POST https://email-services-nu.vercel.app/api/admin \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"set_setting","key":"daily_ceiling","value":95}'
```

Reserves auto-scale to whatever ceiling is set, so lowering it can never starve the low-priority classes.

## 7. After 30 days stable on `on`

1. Remove `SMTP_*` / `EMAIL_*` variables from all four projects.
2. **Rotate the Resend API key.** It has lived in MEDQIZE's and HR-'s repos; afterwards only the gateway should hold it.
3. Delete the legacy sender code paths — kept deliberately until then as the escape hatch.

---

## Testing whenever you want

[`/test`](https://email-services-nu.vercel.app/test) on the dashboard sends a real email on demand, even while `DRY_RUN=true`. Pick the sending project, a template (OTP, owner digest, Arabic/English notice, or your own HTML), and a transport. Defaults to Resend because that is the real delivery path.

## One thing to keep in mind

Resend sends everything; Gmail only takes over when the 100/day budget is exhausted, and only for P0–P2. That means **the digests are the only thing keeping the estate inside the budget** — roughly 25 owner emails a day collapse into 2. If you ever set an owner-facing event to `immediate` instead of `digest:daily`, you are spending real budget on it.
