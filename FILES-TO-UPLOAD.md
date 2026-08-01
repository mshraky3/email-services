# Files to upload

`email-system` is already pushed (github.com/mshraky3/email-services). Everything below is **uncommitted in the four project repos**.

Full paths are relative to `working projects/`.

---

## MEDQIZE — 11 files

```
MEDQIZE/backend/app.js
MEDQIZE/backend/services/mailer.js
MEDQIZE/backend/services/email-client.js          ← NEW
MEDQIZE/backend/services/errorNotificationService.js
MEDQIZE/backend/services/invoiceService.js
MEDQIZE/backend/services/subscriptionReportService.js
MEDQIZE/backend/services/paymentService.js
MEDQIZE/backend/services/userEmailService.js
MEDQIZE/backend/routes/question-reports.js
MEDQIZE/backend/routes/admin-broadcast.js
MEDQIZE/backend/scripts/endFreeEraCampaign.js
```

| File | What changed |
|---|---|
| `services/email-client.js` | **New.** The gateway SDK — one file, zero dependencies. |
| `services/mailer.js` | Routes through the gateway. `sendMail` / `fromWithName` keep their exact signatures, so no call site had to change. Legacy nodemailer kept as the fallback. Converts nodemailer attachments (Buffer) to base64 on the way out, and back again if it falls back. |
| `app.js` | `sendEmail()` gained an optional 5th `opts` argument (additive). OTP, contact form, suggestion, admin-account, temp-link and test-email now name their event. OTP and contact/suggestion also pass `sourceOrigin`. |
| `errorNotificationService.js` | Tagged `medqize.owner.backend_error`; passes `severity`, `sourceOrigin` (the localhost guard) and an hourly idempotency key. |
| `invoiceService.js` | Tagged `medqize.invoice` + idempotency key. **Carries a PDF.** |
| `subscriptionReportService.js` | Tagged `medqize.owner.subscriptions_report`. **Carries a PDF.** |
| `paymentService.js` | Tagged `medqize.owner.payment_received`. |
| `userEmailService.js` | Local `sendEmail` gained an `opts` argument and marks lifecycle mail `bulk: true` so unsubscribes apply. All four lifecycle emails tagged. |
| `routes/question-reports.js` | Local `sendEmail` gained `opts`; all three events tagged. |
| `routes/admin-broadcast.js` | Campaign and test sends tagged; campaign marked `bulk` with a per-recipient idempotency key. |
| `scripts/endFreeEraCampaign.js` | Both sends tagged; the real campaign marked `bulk`. |

Also add to **`MEDQIZE/backend/.env`** and the Vercel dashboard:

```
EMAIL_GATEWAY_URL=https://email-services-nu.vercel.app
EMAIL_GATEWAY_KEY=ek_live_medqize_rWy83-8tFnbmx5isJywbi8m68zgXaFkd
EMAIL_GATEWAY_MODE=shadow
```

---

## HR- — 3 files

```
HR-/express-app/utils/emailService.js
HR-/express-app/utils/email-client.js             ← NEW
HR-/express-app/utils/errorNotificationService.js
```

| File | What changed |
|---|---|
| `email-client.js` | **New.** The gateway SDK. |
| `emailService.js` | Added a `deliver()` chokepoint and an `EVENT_BY_TYPE` map covering all 12 `notificationType` values, so **none of the 16 call sites changed**. OTP tagged with an idempotency key. |
| `errorNotificationService.js` | Routes through the gateway as `hr.owner.system_error`, with `severity` and `sourceOrigin`. |

> ⚠️ This repo has **~213 uncommitted files predating this work**. Run `git status` and commit only the three above, or you will sweep in unrelated changes.

Add to **`HR-/express-app/.env`** and the host:

```
EMAIL_GATEWAY_URL=https://email-services-nu.vercel.app
EMAIL_GATEWAY_KEY=ek_live_hr_uq97D2jHazVaHgBKlhP3YWsPFW2wcTAV
EMAIL_GATEWAY_MODE=shadow
```

---

## portfolio — 2 files

```
portfolio/backend/api.js
portfolio/backend/email-client.js                 ← NEW
```

`Email.sendMail(...)` → `sendMail(...)`, a thin gateway wrapper with the same argument shape, and each of the five sends tagged with its event. Contact form passes `sourceOrigin`; resume pings share a dedupe key so a crawler cannot flood the inbox.

Add to **`portfolio/backend/.env`** and the host:

```
EMAIL_GATEWAY_URL=https://email-services-nu.vercel.app
EMAIL_GATEWAY_KEY=ek_live_portfolio_V6EOG1R_yNgIRYUjn4PQs29_3mgsugi1
EMAIL_GATEWAY_MODE=shadow
```

---

## game — 4 files

```
game/lib/notify.ts                                ← NEW
game/lib/email-client.mjs                         ← NEW
game/app/api/messages/route.ts
game/.env.example
```

This project had no email at all before. `notifyOwner()` is the only entry point and it holds no mail credentials. Player feedback notifies you fire-and-forget, so an email problem can never fail a player's message.

`.mjs` rather than `.js` because this project is CommonJS.

Add to **`game/.env`** and the host:

```
EMAIL_GATEWAY_URL=https://email-services-nu.vercel.app
EMAIL_GATEWAY_KEY=ek_live_game_il3DzOhmVgh1T5ox-F7tk_LTuQ_eby0u
EMAIL_GATEWAY_MODE=on
OWNER_EMAIL=alshraky3@gmail.com
```

(`on` rather than `shadow` — there is no legacy sender to shadow.)

---

## After uploading

Every project stays on `shadow` except `game`, so their own mailers keep sending and the gateway only records. Nothing user-facing changes until you flip `EMAIL_GATEWAY_MODE=on`.

Remaining gateway-side work is in `GO-LIVE.md`: the real `RESEND_WEBHOOK_SECRET` on Vercel, the Resend webhook endpoint, then `DRY_RUN=false`.
