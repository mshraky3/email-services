import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore — the SDK is deliberately plain JS with no build step, so projects
// can copy the single file in without a toolchain.
import { createEmailClient, GatewayError } from '../packages/email-client/email-client.js';

/**
 * The fallback rule is the most dangerous logic in the client.
 *
 * Falling back on the WRONG error means the project sends via its own SMTP
 * after the gateway already refused on quota grounds — the email goes out and
 * the shared daily cap is blown while the ledger believes it is under budget.
 * That is strictly worse than having no gateway at all.
 */

function clientWith(fetchImpl: typeof fetch, mode: 'off' | 'shadow' | 'on' = 'on') {
  const legacyCalls: any[] = [];
  const globalAny = globalThis as any;
  globalAny.fetch = fetchImpl;
  const client = createEmailClient({
    baseUrl: 'https://gw.test',
    apiKey: 'ek_live_test_abc',
    mode,
    legacy: async (payload: any) => { legacyCalls.push(payload); return { viaLegacy: true }; },
    log: () => {},
  });
  return { client, legacyCalls };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('fallback must NOT happen on gateway decisions', () => {
  const mustNotFallBack: Array<[string, number, unknown]> = [
    ['400 validation',        400, { error: 'a valid `to` address is required' }],
    ['413 attachment too big',413, { error: 'attachment_too_large' }],
    ['401 unauthorized',      401, { error: 'unauthorized' }],
  ];

  for (const [name, status, body] of mustNotFallBack) {
    test(`${name} throws instead of using the legacy sender`, async () => {
      const { client, legacyCalls } = clientWith(async () => jsonResponse(status, body));
      await assert.rejects(
        () => client.send({ to: 'a@b.com', subject: 'x', text: 'x' }),
        (err: any) => err instanceof GatewayError && err.status === status,
      );
      assert.equal(legacyCalls.length, 0, `${name} must never reach the legacy sender`);
    });
  }
});

describe('fallback MUST happen when the gateway did not process the request', () => {
  test('a network failure falls back', async () => {
    const { client, legacyCalls } = clientWith(async () => { throw new TypeError('fetch failed'); });
    const out = await client.send({ to: 'a@b.com', subject: 'x', text: 'x' });
    assert.deepEqual(out, { viaLegacy: true });
    assert.equal(legacyCalls.length, 1);
  });

  test('a 500 falls back — an OTP must still go out when the database is down', async () => {
    const { client, legacyCalls } = clientWith(async () => jsonResponse(500, { error: 'gateway_unavailable' }));
    const out = await client.send({ to: 'a@b.com', subject: 'x', text: 'x' });
    assert.deepEqual(out, { viaLegacy: true });
    assert.equal(legacyCalls.length, 1);
  });

  test('502 falls back — the gateway tried and the transport failed', async () => {
    // v3 has no quota refusal, so every 5xx now means "we could not deliver
    // this", and the project's own sender is worth a shot.
    for (const status of [502, 503, 504]) {
      const { client, legacyCalls } = clientWith(async () => jsonResponse(status, { error: 'bad gateway' }));
      await client.send({ to: 'a@b.com', subject: 'x', text: 'x' });
      assert.equal(legacyCalls.length, 1, `HTTP ${status} should fall back`);
    }
  });
});

describe('success statuses are returned, never retried', () => {
  // Only 'sent' actually put an email in flight; the rest are deliberate
  // gateway decisions that must not be second-guessed by falling back.
  for (const status of ['sent', 'suppressed', 'dropped', 'throttled', 'duplicate']) {
    test(`"${status}" is surfaced as a successful result`, async () => {
      const { client, legacyCalls } = clientWith(async () => jsonResponse(200, { ok: true, status }));
      const out: any = await client.send({ to: 'a@b.com', subject: 'x', text: 'x' });
      assert.equal(out.status, status);
      assert.equal(legacyCalls.length, 0, 'a success must not also hit the legacy sender');
    });
  }
});

describe('modes', () => {
  test('off never calls the gateway', async () => {
    let called = false;
    const { client, legacyCalls } = clientWith(async () => { called = true; return jsonResponse(200, {}); }, 'off');
    await client.send({ to: 'a@b.com', subject: 'x', text: 'x' });
    assert.equal(called, false);
    assert.equal(legacyCalls.length, 1);
  });

  test('shadow sends via legacy AND records to the gateway', async () => {
    let gatewayCalls = 0;
    const { client, legacyCalls } = clientWith(async () => { gatewayCalls++; return jsonResponse(200, { ok: true }); }, 'shadow');
    const out = await client.send({ to: 'a@b.com', subject: 'x', text: 'x' });
    assert.deepEqual(out, { viaLegacy: true }, 'legacy is the real sender in shadow mode');
    await new Promise((r) => setTimeout(r, 20)); // the shadow call is fire-and-forget
    assert.equal(gatewayCalls, 1);
  });

  test('a failing gateway in shadow mode cannot break the real send', async () => {
    const { client, legacyCalls } = clientWith(async () => { throw new Error('gateway on fire'); }, 'shadow');
    const out = await client.send({ to: 'a@b.com', subject: 'x', text: 'x' });
    assert.deepEqual(out, { viaLegacy: true });
    assert.equal(legacyCalls.length, 1);
  });
});
