import { NextResponse } from 'next/server';

/**
 * Wrap a route handler so infrastructure failures become a clean JSON 500
 * instead of an unhandled exception.
 *
 * THE STATUS CODE MATTERS MORE THAN IT LOOKS.
 *
 * The client SDK treats 5xx-except-503 as "the gateway did not process this,
 * fall back to the project's own SMTP". So:
 *
 *   500  infrastructure is down (database unreachable, unhandled bug)
 *        -> the SDK SHOULD fall back. An OTP must still go out when Neon is
 *           having a bad day.
 *
 *   503  reserved EXCLUSIVELY for quota_exhausted
 *        -> the SDK must NOT fall back. Falling back here would send the email
 *           anyway and blow the daily cap while the ledger believes it is under
 *           budget, which is worse than having no gateway at all.
 *
 * On the SEND path, never return 503 for anything other than quota.
 * (/api/v1/health also uses 503, in its conventional "service unavailable"
 * sense — that is fine because the SDK never sends through it.)
 */
export function guard(handler: (req: Request, ctx: any) => Promise<Response>) {
  return async (req: Request, ctx: any): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      const message = (err as Error)?.message ?? 'internal error';
      console.error('[gateway]', message);
      return NextResponse.json(
        { ok: false, error: 'gateway_unavailable', detail: message },
        { status: 500 },
      );
    }
  };
}
