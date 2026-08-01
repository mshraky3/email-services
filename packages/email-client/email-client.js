/**
 * Email gateway client — zero dependencies, native fetch (Node 18+), ESM.
 *
 * Copy this ONE file into a project (e.g. services/email-client.js) and point
 * it at the gateway. No npm install, no build step.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE THREE MODES
 *
 *   off     legacy sender only. The gateway is not called at all.
 *   shadow  legacy sender actually sends; the gateway is called in parallel and
 *           only records what it WOULD have done. Zero user-visible change.
 *           Run in this mode for a week before flipping to `on`.
 *   on      the gateway sends. Falls back to the legacy sender ONLY on
 *           infrastructure failure — see the fallback rule below.
 *
 * Cutover and rollback are one env var. No code change, no redeploy of the
 * gateway.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE FALLBACK RULE — the subtlest part of this file
 *
 * Falling back on *any* error defeats the entire system. If the gateway says
 * "quota exhausted" and the project then sends via its own SMTP anyway, the
 * email goes out and the daily cap is blown while the ledger believes it is
 * under budget. That is worse than not having a gateway at all.
 *
 * So the ONLY fallback-eligible failures are ones that mean "the gateway did
 * not process this": network errors, timeouts, and genuine 5xx. Explicitly NOT
 * eligible:
 *   429 project_daily_cap    the gateway decided; respect it
 *   503 quota_exhausted      a quota signal wearing a 5xx costume
 *   4xx validation           the payload is wrong; sending it elsewhere is worse
 *   200 suppressed/buffered/dropped/duplicate   these are SUCCESSES
 */

const TERMINAL_OK = new Set(['sent', 'queued', 'buffered', 'suppressed', 'dropped', 'duplicate']);

export class GatewayError extends Error {
  constructor(kind, message, status, body) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind; // 'network' | 'timeout' | 'http'
    this.status = status;
    this.body = body;
  }
}

function isFallbackEligible(err) {
  if (!(err instanceof GatewayError)) return false;
  if (err.kind === 'network' || err.kind === 'timeout') return true;
  // 503 is excluded deliberately: it is how the gateway reports quota
  // exhaustion for P0, and falling back there would double-spend the budget.
  return typeof err.status === 'number' && err.status >= 500 && err.status !== 503;
}

/**
 * @param {object} cfg
 * @param {string}   cfg.baseUrl   e.g. https://email-system.vercel.app
 * @param {string}   cfg.apiKey    ek_live_<slug>_...
 * @param {'off'|'shadow'|'on'} [cfg.mode]
 * @param {(payload:object)=>Promise<any>} [cfg.legacy]  the project's existing sender
 * @param {number}   [cfg.timeoutMs]
 * @param {(msg:string, err?:unknown)=>void} [cfg.log]
 */
export function createEmailClient(cfg) {
  const {
    baseUrl,
    apiKey,
    mode = process.env.EMAIL_GATEWAY_MODE || 'off',
    legacy,
    timeoutMs = 8000,
    log = (m, e) => console.warn(`[email-client] ${m}`, e ?? ''),
  } = cfg ?? {};

  async function call(path, init) {
    if (!baseUrl || !apiKey) throw new GatewayError('network', 'gateway baseUrl/apiKey not configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (err) {
      throw new GatewayError(err?.name === 'AbortError' ? 'timeout' : 'network', err?.message ?? 'fetch failed');
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }

    if (!res.ok) throw new GatewayError('http', body?.error ?? `HTTP ${res.status}`, res.status, body);
    return body;
  }

  async function viaGateway(path, payload) {
    if (mode === 'off') {
      if (!legacy) throw new GatewayError('network', 'mode=off but no legacy sender was provided');
      return legacy(payload);
    }

    if (mode === 'shadow') {
      // Record-only. Never awaited, never allowed to affect the real send.
      call(path, { method: 'POST', body: JSON.stringify({ ...payload, dryRun: true }) })
        .catch((err) => log('shadow call failed (ignored)', err?.message));
      if (!legacy) throw new GatewayError('network', 'mode=shadow but no legacy sender was provided');
      return legacy(payload);
    }

    try {
      return await call(path, { method: 'POST', body: JSON.stringify(payload) });
    } catch (err) {
      if (legacy && isFallbackEligible(err)) {
        log(`gateway unreachable (${err.kind}${err.status ? ' ' + err.status : ''}) — using legacy sender`);
        return legacy(payload);
      }
      throw err;
    }
  }

  return {
    /**
     * Tier A — you already have the rendered HTML.
     *
     * Signature deliberately matches MEDQIZE's existing
     * backend/services/mailer.js `sendMail`, so migrating that project is an
     * internals swap in one file and all 22 call sites stay untouched.
     */
    send(payload) {
      return viaGateway('/api/v1/send', payload);
    },

    /**
     * Tier B — structured event the gateway may merge into a digest.
     * Use for anything owner-facing.
     */
    notify(event) {
      return viaGateway('/api/v1/notify', event);
    },

    /**
     * Many recipients, one payload. Returns 202 immediately with an honest
     * schedule rather than blocking while N emails go out inline.
     */
    sendBulk(payload) {
      return viaGateway('/api/v1/send/bulk', payload);
    },

    /**
     * Ask before generating work. Crons should size their batch from this
     * instead of hardcoding a LIMIT that the gateway will only drop.
     */
    async quota({ priority } = {}) {
      const qs = priority === undefined ? '' : `?priority=${priority}`;
      return call(`/api/v1/quota${qs}`, { method: 'GET' });
    },

    async status(id) {
      return call(`/api/v1/messages/${id}`, { method: 'GET' });
    },

    async health() {
      return call('/api/v1/health', { method: 'GET' });
    },

    get mode() { return mode; },
  };
}

/** Read a file into the base64 shape the gateway expects for attachments. */
export function attachmentFromBuffer(filename, buffer, contentType = 'application/pdf') {
  return { filename, content: Buffer.from(buffer).toString('base64'), content_type: contentType };
}
