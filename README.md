# Central Email System

One gateway that sends email for MEDQIZE (SQB), HR-, portfolio and game.

**Live:** https://email-services-nu.vercel.app · **Onboarding a new project?** Read [`email.txt`](email.txt) — it is self-contained.

---

## How it works

A request arrives, the email goes out, the caller gets the real result. There is **no queue and no scheduler** — no cron job to configure, nothing to poll, nothing that can silently stop draining.

Transport is decided by one question: **is there Resend budget left today?**

- **Yes** → Resend, on the verified domain `smle-question-bank.com`. This is how essentially all mail goes out.
- **No** → Gmail SMTP, which has its own separate 500/day allowance. Unauthenticated for this domain and more likely to land in spam, but a message in spam beats one never sent.

Nothing is ever deferred or refused for quota reasons, which is why there are no priorities, reserves or ceilings: those only existed to decide what to drop when full, and nothing is dropped.

## What it still does for you

| | |
|---|---|
| **Origin gate** | Mail from a non-production host is dropped. This is what stops a frontend running on localhost against the production backend from firing real error alerts. Hostnames are per-project, so onboarding never needs a gateway redeploy. |
| **Suppression** | Bounces and spam complaints (via Resend webhook) stop future mail to that address. Every project shares one domain and one reputation, so a bounce anywhere hurts everywhere. A hard bounce blocks everything including OTP; an unsubscribe blocks marketing only. |
| **Idempotency** | A repeated `idempotencyKey` returns the original result instead of sending twice. |
| **Flood cooldown** | Give an error alert a `dedupeKey` and identical repeats inside the window are swallowed and counted — one broken endpoint sends one email, not forty-seven. |
| **Delivery log** | Every message, its outcome, its transport and its provider id. "Did that actually send?" is answerable. |
| **Inline retry** | Transient failures retry twice on the spot. Anything still failing is parked and picked up by the next inbound request — ordinary traffic is the recovery mechanism. |

## Setup

```bash
cp .env.example .env.local     # DATABASE_URL, Resend + Gmail credentials, secrets
npm install
npm run db:init                # apply schema (idempotent)
npm run db:seed                # register projects + events; prints API keys ONCE
npm run dev                    # http://localhost:3100
```

## Verify

```bash
npm run preflight              # credentials, database, Resend domain, Gmail — sends nothing
npm test                       # 51 unit tests, no database needed
```

With the dev server running:

```bash
GATEWAY_URL=http://localhost:3100 SMOKE_KEY=ek_live_medqize_... npm run smoke
```

```bash
GATEWAY_URL=http://localhost:3100 npm run verify:projects
```

- `preflight` validates the Resend key read-only (`GET /domains`, which also confirms the domain is verified) and authenticates Gmail with an SMTP handshake.
- `smoke` (23 checks) proves each decision: sends return `sent` not `queued`, dev origins are dropped, identical errors are throttled, a replayed key does not re-send.
- `verify:projects` (21 checks) asserts every registered project's events behave as configured, and that a forged key is rejected.

## Sending a test email

[`/test`](https://email-services-nu.vercel.app/test) sends a real message on demand, deliberately bypassing `DRY_RUN` — a test page that respects dry-run cannot tell you whether mail arrives. Pick a project (sets the From identity), a template, and a transport. Gated by `ADMIN_KEY`.

`GET /api/admin/preflight` reports the readiness of the **running** instance: which env vars production actually has, whether Resend and Gmail work.

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/v1/send` | project key | Send an email. Returns when it has been sent. |
| `POST /api/v1/send/bulk` | project key | Many recipients, paced, reported per-recipient |
| `POST /api/v1/notify` | project key | Structured fields instead of HTML — the gateway renders it |
| `GET /api/v1/quota` | project key | Budget left. Informational; nothing is refused when it runs out |
| `GET /api/v1/messages/:id` | project key | Status, provider id, delivery events |
| `POST /api/webhooks/resend` | Svix signature | Bounce/complaint → suppression |
| `GET /api/v1/health` | none | Sent/failed counts, anything awaiting retry, budget |
| `GET\|POST /u/:token` | HMAC | One-click unsubscribe |
| `POST /api/admin` | `ADMIN_KEY` | Projects, keys, policies, origins, settings |

No CORS layer and no URL allowlisting — every caller is server-to-server, so the bearer key is the whole gate.

## Operational notes

- **`daily_budget`** (default 95) is the only tunable that matters: the point at which Resend hands over to Gmail. Change it with `POST /api/admin {"action":"set_setting","key":"daily_budget","value":95}` — no redeploy.
- **`production_origins` must be set per project**, or that project's mail is dropped as dev traffic. First thing to check when mail goes missing.
- **Attachments** are base64, max 2 MB each / 3 MB per request, and the stored bytes are purged 24h after sending (invoices are PII).
- **`RESEND_WEBHOOK_SECRET` must be Resend's real signing secret**, or bounces go unrecorded and dead addresses keep getting mail.

## Known gaps

- **Real volume is unmeasured.** The 95/day budget has never actually been reached, so the Gmail hand-over has not been exercised against a genuinely exhausted budget.
- **A failed send needs traffic to recover.** With no scheduler, a parked message waits for the next inbound request. In practice that is seconds; on a completely idle gateway it could be longer — but nobody is waiting on mail from an idle gateway either.
