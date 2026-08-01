
/**
 * Retained only to grade suppressions: a hard bounce blocks everything (0),
 * an unsubscribe blocks marketing only (2). It no longer schedules anything.
 */
export type Priority = 0 | 1 | 2 | 3 | 4;

export type Audience = 'owner' | 'internal' | 'user';
export type TransportName = 'resend' | 'gmail' | 'noop';
export type Severity = 'info' | 'warn' | 'critical';

/**
 * Map a caller's severity onto our three-level scale.
 *
 * The projects do not share our vocabulary: MEDQIZE's errorNotificationService
 * and HR-'s both classify errors as CRITICAL / HIGH / MEDIUM / LOW.
 *
 * Anything unrecognised degrades to 'info' rather than throwing: an unknown
 * label is not a good reason to lose an error report.
 */
export function normalizeSeverity(raw: unknown): Severity {
  switch (String(raw ?? '').trim().toLowerCase()) {
    case 'critical':
    case 'fatal':
    case 'emergency':
      return 'critical';
    case 'high':
    case 'warn':
    case 'warning':
    case 'error':
      return 'warn';
    default:
      return 'info';
  }
}

export type MessageStatus =
  | 'sending'      // handed to a transport, outcome not yet known
  | 'sent'
  | 'failed'       // retried by the next inbound request
  | 'dropped'      // non-production origin
  | 'suppressed'   // bounced / complained / unsubscribed
  | 'throttled'    // identical repeat inside the cooldown window
  | 'cancelled';

export interface ProjectRow {
  id: number;
  slug: string;
  display_name: string;
  from_local_part: string;
  default_from_name: string;
  reply_to: string | null;
  default_locale: string;
  default_dir: 'rtl' | 'ltr';
  best_priority: Priority;
  daily_max: number;
  monthly_max: number;
  allowed_transports: TransportName[];
  production_origins: string[];
  dry_run: boolean;
  active: boolean;
}

export interface PolicyRow {
  id: number;
  project_id: number;
  event_type: string;
  priority: Priority;
  audience: Audience;
  transport_hint: TransportName | null;
  honors_unsubscribe: boolean;
  /** Seconds to swallow identical dedupe_key repeats. 0 = never. */
  cooldown_seconds: number;
  active: boolean;
}

export interface Attachment {
  filename: string;
  /** base64 payload. Mutually exclusive with `url`. */
  content?: string;
  /** Remote fetchable URL. Preferred above ~1 MB. */
  url?: string;
  content_type?: string;
}

export interface MessageRow {
  id: string;
  project_id: number;
  event_type: string;
  audience: Audience;
  to_address: string;
  to_name: string | null;
  from_name: string;
  from_address: string;
  reply_to: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  locale: string;
  dir: 'rtl' | 'ltr';
  status: MessageStatus;
  status_reason: string | null;
  transport: TransportName;
  provider_id: string | null;
  attempts: number;
  last_error: string | null;
  idempotency_key: string | null;
  dedupe_key: string | null;
  source_origin: string | null;
  severity: Severity;
  retry_after: Date | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** One entry inside a rendered digest — used by the test page's sample. */
export interface DigestItem {
  title: string;
  summary?: string;
  severity?: Severity;
  dir?: 'rtl' | 'ltr';
  occurred_at?: string;
  fields?: Array<{ label: string; value: string }>;
  link?: { label: string; url: string };
}

/** Result of a transport attempt. */
export interface SendResult {
  id: string | null;
  transport: TransportName;
  dryRun?: boolean;
}

/**
 * Error classes the send path and the client SDK branch on.
 *
 * `quota` is special: it means Resend's daily budget is spent, and the send
 * path reacts by switching to Gmail and retrying immediately rather than
 * failing. It is never surfaced to the caller as an error.
 */
export type FailureKind = 'network' | 'timeout' | 'rate_limit' | 'quota' | 'validation' | 'server';

export class TransportError extends Error {
  kind: FailureKind;
  status?: number;
  retryAfterSeconds?: number;

  constructor(kind: FailureKind, message: string, status?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Transient failures are worth another attempt; the rest are terminal. */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'rate_limit' || this.kind === 'server';
  }
}
