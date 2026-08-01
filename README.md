# Central Email System

One gateway that sends email for MEDQIZE (SQB), HR-, portfolio and game, rationing a single Resend free-tier quota across all of them.

**Onboarding a new project?** Read [`email.txt`](email.txt) — it is self-contained and is the only file a new project needs.

---

## Why it exists

Two projects already shared one Resend account, one API key and one verified domain, with no shared accounting and no delivery log. Resend free is **100 emails/day, 3,000/month, 1 domain**, and the projects' combined theoretical peak is several times that.

A scheduler alone would just move the failure from "Resend 429s" to "the gateway dropped your email". Two things create real headroom, and they matter more than the scheduler:

1. **Owner mail goes over Gmail.** Roughly a quarter of all traffic is the owner emailing himself (MEDQIZE's 9 owner notifications, HR-'s error reports, portfolio's 5 types). None of it needs the verified domain's reputation. `audience: 'owner'` routes to Gmail SMTP — 500/day on a separate quota — and costs **zero** Resend budget.
2. **Digests.** ~25 owner emails/day collapse into 2, with repeats counted (`DB connection refused ×47`) instead of re-sent.

## The guarantee

Reserved-capacity admission control, with floors that release when unused:

| P | Class | Reserve | Ceiling |
|---|---|---|---|
| 0 | urgent — OTP, password reset | 25 | 95 |
| 1 | transactional — invoice, receipt | 20 | 60 |
| 2 | operational — admin alerts | 10 | 25 |
| 3 | lifecycle — welcome, streak | 0 | 30 |
| 4 | bulk — campaigns | 0 | 40 |

```
heldAbove(k) = Σ_{j<k} max(0, reserve[j] − used[j])
admit(k)     = dailyCeiling − usedTotal − heldAbove(k) ≥ 1
             ∧ used[k] < effectiveCeiling(k)
             ∧ project and monthly limits
```

**No volume of P1–P4 can reduce P0's available capacity below its reserve.** Proven in `tests/quota.test.ts` by an adversarial flood: after 70 lower-priority emails are admitted, P0 still gets exactly 25.

The window is a **rolling 24h**, not a calendar day — Resend does not document its reset timezone, and a rolling window is a strict superset of any calendar-day window, so it cannot be violated wherever the provider draws the line.

## Setup

```bash
cp .env.example .env.local     # fill in DATABASE_URL and the secrets
npm install
npm run db:init                # apply schema (idempotent)
npm run db:seed                # register 4 projects + 46 event policies; prints API keys ONCE
npm run dev                    # http://localhost:3100
```

Keep `DRY_RUN=true` until the gateway has been observed for a full shadow week.

## Verify

```bash
npm run preflight    # credentials, database, Resend domain, Gmail SMTP — sends nothing
npm test             # 70 unit tests, no database needed
```

With the dev server running and a project key exported:

```bash
GATEWAY_URL=http://localhost:3100 SMOKE_KEY=ek_live_medqize_... npm run smoke
```

```bash
GATEWAY_URL=http://localhost:3100 SMOKE_KEY=ek_live_medqize_... npm run verify:live
```

- `preflight` validates the Resend key read-only (`GET /domains`, which also confirms the domain is verified) and authenticates Gmail with an SMTP handshake. No email, no quota.
- `smoke` (20 checks) proves the decisions that can lose mail: the origin gate drops localhost, repeated errors buffer instead of sending, CRITICAL escalates out of the digest, a replayed idempotency key does not re-send, owner mail consumes no Resend quota.
- `verify:live` (18 checks) exercises the machinery that only exists with a real database: claiming under `SKIP LOCKED`, the advisory lock under concurrent drains, the atomic digest freeze-flush, and webhook → suppression → withheld send. It cleans up after itself.

## Deploying

See [`DEPLOY.md`](DEPLOY.md).

## Draining the queue

Vercel Hobby crons run **at most once a day** (±59 min), which is useless for a queue. Three layers instead:

1. **Opportunistic** — every authenticated API call drains a few due messages. Free, and any traffic keeps the queue moving.
2. **cron-job.org** every 5 min → `POST /api/v1/drain` with `Authorization: Bearer $DRAIN_SECRET`. This is the primary.
3. **GitHub Actions** every 15 min (`.github/workflows/drain.yml`) as backup — its free cron is often 10–60 min late, so never rely on it alone.

Overlapping ticks are a no-op via a Postgres advisory lock.

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/v1/send` | project key | Rendered email. P0 sends inline (200), others queue (202) |
| `POST /api/v1/send/bulk` | project key | Many recipients, one payload. Always 202 with an honest schedule |
| `POST /api/v1/notify` | project key | Structured event — the gateway decides immediate vs digest |
| `GET /api/v1/quota` | project key | Remaining by priority; crons size their batch from this |
| `GET /api/v1/messages/:id` | project key | Status, provider id, delivery events |
| `POST /api/v1/drain` | `DRAIN_SECRET` | Scheduler tick |
| `POST /api/webhooks/resend` | Svix signature | Bounce/complaint → suppression |
| `GET /api/v1/health` | none | Queue depth, oldest pending age, quota |
| `GET|POST /u/:token` | HMAC | One-click unsubscribe |
| `POST /api/admin` | `ADMIN_KEY` | Projects, keys, policies, quota tuning, retry |

No CORS layer and no URL allowlisting — every caller is server-to-server, so the bearer key is the whole gate.

## Operational notes

- **Quota numbers live in tables** (`quota_policy`, `quota_settings`), not constants. Retune with `POST /api/admin {action:'set_class'|'set_setting'}` — no redeploy.
- **`daily_ceiling` ships at 40, not 95.** During migration both the projects and the gateway send, but the gateway only sees its own traffic. Raise it as each project cuts over.
- **500 vs 503 is load-bearing.** 500 means infrastructure is down and the client SDK *should* fall back to the project's own sender. 503 is reserved for `quota_exhausted`, where falling back would send the email anyway and blow the shared cap. Never conflate them.
- **Attachments are purged** 24h after a terminal status — invoices and subscriber reports are PII and must not accumulate here.
- **Suppression is not binary.** A complaint or hard bounce blocks everything including OTP; an unsubscribe blocks P2–P4 only, because nobody can opt out of their own password reset.

## Known gaps

- **No real email has been sent yet.** Everything runs with `DRY_RUN=true`. Credentials are proven (Resend key valid, domain verified, Gmail authenticated) but the final hop — a message actually landing in an inbox — is unverified until you flip `DRY_RUN=false` and send one.
- **Real volume is unmeasured.** Every quota number is inferred from reading the projects' source, not from counting actual sends. Run the shadow phase before trusting them; that is what the `daily_ceiling=40` migration setting exists for.
- **`RESEND_WEBHOOK_SECRET` is a placeholder.** Replace it with Resend's real signing secret when you create the webhook endpoint, or bounce and complaint handling stays inert.
