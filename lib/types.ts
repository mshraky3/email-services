import type { Priority } from './quota.ts';

export type Audience = 'owner' | 'internal' | 'user';
export type TransportName = 'resend' | 'gmail' | 'noop';
export type Severity = 'info' | 'warn' | 'critical';

/**
 * Map a caller's severity onto our three-level scale.
 *
 * The projects do not share our vocabulary. MEDQIZE's errorNotificationService
 * and HR-'s classify errors as CRITICAL / HIGH / MEDIUM / LOW, and passing
 * those through unchanged violates the digest_buffer CHECK constraint and 500s
 * the whole request.
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
  | 'queued'
  | 'claimed'
  | 'attempting'
  | 'sent'
  | 'failed'
  | 'dead'
  | 'expired'
  | 'suppressed'
  | 'dropped'
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
  delivery_mode: 'immediate' | 'digest:hourly' | 'digest:daily' | 'digest:weekly' | 'suppress';
  digest_key_template: string | null;
  dedupe_key_template: string | null;
  flush_threshold: number;
  escalate_when: Record<string, unknown> | null;
  escalated_priority: Priority | null;
  transport_hint: TransportName | null;
  ttl_seconds: number | null;
  honors_unsubscribe: boolean;
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
  priority: Priority;
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
  batch_id: string | null;
  digest_of: string | null;
  source_origin: string | null;
  scheduled_at: Date;
  expires_at: Date;
  claimed_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** One entry inside a rendered digest. Structure, not HTML — see lib/digest.ts. */
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
 * Error classes the drain loop and the client SDK branch on.
 *
 * The distinction that matters most: `quota` must NEVER cause the client SDK
 * to fall back to a project's legacy SMTP sender. Doing so sends the email
 * anyway and blows the cap while the ledger believes it is under budget.
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
