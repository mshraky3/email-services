# What changed in each project

All four projects are now wired to the gateway at `https://email-services-nu.vercel.app`, verified live (19/19 connectivity checks).

**Every project is on `EMAIL_GATEWAY_MODE=shadow`.** Their existing mailers still do the real sending; the gateway only records what it *would* have done. Nothing user-facing has changed yet. Flip to `on` per project when you've watched the dashboard for a week.

> `.env` files are gitignored in every project, so the three `EMAIL_GATEWAY_*` variables must be added by hand in each host's dashboard (Vercel → Settings → Environment Variables) as well. Env changes need a redeploy to take effect.

---

## MEDQIZE (SQB)

| File | Change |
|---|---|
| `backend/services/email-client.js` | **new** — the gateway SDK, zero dependencies |
| `backend/services/mailer.js` | rewritten to route through the gateway. `sendMail` and `fromWithName` keep their exact signatures, so **all 22 call sites were untouched**. The legacy nodemailer transport is retained as the fallback. |
| `backend/services/errorNotificationService.js` | tagged `medqize.owner.backend_error`, passes `severity` and `sourceOrigin` |
| `backend/app.js` | `sendEmail(...)` gained an optional 5th `opts` argument (additive — existing calls unchanged); OTP, admin-account, test-email and temp-link sends now name their event |
| `backend/.env` | added `EMAIL_GATEWAY_URL`, `EMAIL_GATEWAY_KEY`, `EMAIL_GATEWAY_MODE=shadow` |

What it buys: the 9 owner-notification types now ride Gmail and cost **zero Resend quota**, error reports collapse into an hourly digest, and dev-origin error mail is dropped.

## HR-

| File | Change |
|---|---|
| `express-app/utils/email-client.js` | **new** |
| `express-app/utils/emailService.js` | added a `deliver()` chokepoint and an `EVENT_BY_TYPE` map, so all 12 `notificationType` values route correctly with **no changes to the 16 call sites** |
| `express-app/utils/errorNotificationService.js` | routes through the gateway, tagged `hr.owner.system_error` with `severity` + `sourceOrigin` |
| `express-app/.env` | added the three gateway variables |

Note: HR- has a git repo with ~213 uncommitted files predating this work. Review `git status` before committing so you don't sweep unrelated changes in.

## portfolio

| File | Change |
|---|---|
| `backend/email-client.js` | **new** |
| `backend/api.js` | `Email.sendMail(...)` → `sendMail(...)`, a thin gateway wrapper with the same argument shape; each of the 5 sends tagged with its event |
| `backend/.env` | added the three gateway variables |

All 5 of its emails go to you, so they're all `audience: 'owner'` → Gmail → **zero Resend quota**, while still being logged and digested with everything else. Contact-form and resume pings now fold into the daily digest; both cron emails stay immediate.

## game (te3rafni)

| File | Change |
|---|---|
| `lib/email-client.mjs` | **new** (`.mjs` because this project is CommonJS) |
| `lib/notify.ts` | **new** — `notifyOwner()`, the only email entry point |
| `app/api/messages/route.ts` | player feedback now notifies you, fire-and-forget so an email problem can never fail a player's message |
| `.env.example` | documents the gateway variables |

This project had no email at all before. It uses Tier C (central templates) and holds no mail credentials — the proof that a new app can connect using only `email.txt`.

---

## Rolling out

1. Add the three `EMAIL_GATEWAY_*` variables to each project's host, redeploy.
2. Watch `https://email-services-nu.vercel.app` for a week in shadow mode. Compare: every legacy send should have exactly one gateway record.
3. Flip to `EMAIL_GATEWAY_MODE=on` one project at a time — **portfolio → game → HR- → MEDQIZE**, riskiest last.
4. Set `DRY_RUN=false` on the gateway when the first project flips to `on`.
5. Raise `daily_ceiling` from 40 toward 95 as each project cuts over (see DEPLOY.md §5).

Rollback at any point is `EMAIL_GATEWAY_MODE=off` on that project. No code change.

## Once everything is on `on` and stable for 30 days

- Remove `SMTP_*` / `EMAIL_*` variables from all four projects.
- **Rotate the Resend API key** — it has lived in MEDQIZE's and HR-'s repos. Afterwards only the gateway should hold it.
- Delete the legacy sender code paths (kept deliberately until then as the escape hatch).
