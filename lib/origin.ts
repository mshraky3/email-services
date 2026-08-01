/**
 * Production-origin gate.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   Running a frontend on localhost against the PRODUCTION backend makes that
 *   backend fire real error-report emails. Every stack trace from a dev session
 *   lands in the owner's inbox and burns shared quota.
 *
 *   The signal is already present in both projects:
 *     MEDQIZE  services/errorNotificationService.js
 *              page: req?.headers?.referer || req?.headers?.origin
 *     HR-      routes/error-report.js
 *              page: page || req.headers.referer
 *
 *   So the caller can always tell us where the request really came from, and we
 *   drop anything that is not a known production host. Dropped messages are
 *   recorded (status 'dropped') so they stay visible in the dashboard — they
 *   are just never sent and never counted against quota.
 *
 * Applied in TWO places by design: here (central, survives a project
 * forgetting) and at each project's /api/error-report intake (avoids the
 * network call entirely).
 */

export type OriginVerdict =
  | { production: true; host: string | null }
  | { production: false; host: string | null; reason: string };

/** Hosts that are never production, regardless of configuration. */
const NON_PROD_EXACT = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const NON_PROD_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /^localhost(:\d+)?$/i, reason: 'localhost' },
  { re: /^127\./, reason: 'loopback' },
  { re: /^\[?::1\]?(:\d+)?$/, reason: 'ipv6 loopback' },
  { re: /^10\./, reason: 'private network' },
  { re: /^192\.168\./, reason: 'private network' },
  { re: /^172\.(1[6-9]|2\d|3[01])\./, reason: 'private network' },
  { re: /\.local(:\d+)?$/i, reason: 'mDNS .local' },
  { re: /\.localhost(:\d+)?$/i, reason: '.localhost' },
  { re: /^.*\.ngrok(-free)?\.(io|app|dev)$/i, reason: 'tunnel' },
  { re: /^.*\.trycloudflare\.com$/i, reason: 'tunnel' },
];

/** Extract a bare host from a URL, an Origin header, or an already-bare host. */
export function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    return new URL(withScheme).host.toLowerCase();
  } catch {
    return value.toLowerCase().split('/')[0] || null;
  }
}

function configuredProductionHosts(): string[] {
  return (process.env.PRODUCTION_ORIGINS ?? '')
    .split(',')
    .map((s) => hostOf(s))
    .filter((s): s is string => Boolean(s));
}

/**
 * Judge an origin.
 *
 * A missing origin is treated as PRODUCTION. Server-side senders (cron jobs,
 * webhooks, payment callbacks) legitimately have no referer, and refusing them
 * would silently kill invoices and OTPs. The gate exists to stop browser-origin
 * dev traffic, so it only ever rejects an origin it can actually see.
 */
export function judgeOrigin(
  rawOrigin: string | null | undefined,
  /**
   * Hostnames registered for the calling project, merged with the global
   * allowlist. This is what lets a new app be onboarded without redeploying
   * the gateway — see `projects.production_origins`.
   */
  projectOrigins: string[] = [],
): OriginVerdict {
  const host = hostOf(rawOrigin);
  if (!host) return { production: true, host: null };

  const bare = host.replace(/:\d+$/, '');

  if (NON_PROD_EXACT.has(bare) || NON_PROD_EXACT.has(host)) {
    return { production: false, host, reason: 'localhost' };
  }
  for (const { re, reason } of NON_PROD_PATTERNS) {
    if (re.test(host) || re.test(bare)) return { production: false, host, reason };
  }

  const allowed = [
    ...configuredProductionHosts(),
    ...projectOrigins.map((h) => hostOf(h)).filter((h): h is string => Boolean(h)),
  ];

  // No allowlist configured: accept anything that is not obviously local. This
  // keeps a fresh deployment working before PRODUCTION_ORIGINS is filled in,
  // while still killing the localhost case that motivated this gate.
  if (allowed.length === 0) return { production: true, host };

  const bareAllowed = allowed.map((h) => h.replace(/:\d+$/, ''));
  if (bareAllowed.includes(bare)) return { production: true, host };

  // Vercel preview deployments look like <project>-<hash>-<scope>.vercel.app.
  // The real production alias is expected to be listed explicitly, so anything
  // else on vercel.app is a preview and must not email anyone.
  if (/\.vercel\.app$/i.test(bare)) {
    return { production: false, host, reason: 'vercel preview deployment' };
  }

  return { production: false, host, reason: 'not in PRODUCTION_ORIGINS' };
}
