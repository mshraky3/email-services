import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { judgeOrigin, hostOf } from '../lib/origin.ts';

const PROD = 'smle-question-bank.com,medquiz.vercel.app,hr-react-theta.vercel.app,alshraky.com';

describe('hostOf', () => {
  test('extracts a host from every shape a referer arrives in', () => {
    assert.equal(hostOf('http://localhost:5173/quiz'), 'localhost:5173');
    assert.equal(hostOf('https://medquiz.vercel.app/admin?x=1'), 'medquiz.vercel.app');
    assert.equal(hostOf('medquiz.vercel.app'), 'medquiz.vercel.app');
    assert.equal(hostOf('MEDQUIZ.VERCEL.APP'), 'medquiz.vercel.app');
    assert.equal(hostOf(''), null);
    assert.equal(hostOf(null), null);
    assert.equal(hostOf(undefined), null);
  });
});

describe('the localhost-against-prod-backend case', () => {
  beforeEach(() => { process.env.PRODUCTION_ORIGINS = PROD; });

  // This is the exact scenario that motivated the gate: a dev frontend on
  // localhost pointed at the production backend, generating real error emails.
  // MEDQIZE reports referer as `page`; HR- reports it the same way.
  const devOrigins = [
    'http://localhost:5173/quiz',          // MEDQIZE vite dev
    'http://localhost:5174/admin',         // HR- vite dev
    'http://127.0.0.1:3000/',
    'http://[::1]:3000/',
    'https://192.168.1.42:5173/dashboard', // phone testing on the LAN
    'http://10.0.0.7:5173/',
    'http://mymachine.local:5173/',
    'https://medquiz-git-featurex-abc123.vercel.app/', // preview deployment
  ];

  for (const origin of devOrigins) {
    test(`drops ${origin}`, () => {
      const v = judgeOrigin(origin);
      assert.equal(v.production, false, `${origin} must not be treated as production`);
      assert.ok('reason' in v && v.reason.length > 0);
    });
  }

  const prodOrigins = [
    'https://medquiz.vercel.app/quiz',
    'https://smle-question-bank.com/',
    'https://hr-react-theta.vercel.app/admin',
    'https://alshraky.com/contact',
  ];

  for (const origin of prodOrigins) {
    test(`allows ${origin}`, () => {
      assert.equal(judgeOrigin(origin).production, true, `${origin} must be treated as production`);
    });
  }
});

describe('server-side senders', () => {
  beforeEach(() => { process.env.PRODUCTION_ORIGINS = PROD; });

  test('a missing origin is production, not a drop', () => {
    // Cron jobs, payment webhooks and server-side OTP calls legitimately have
    // no referer. Refusing them would silently kill invoices and password
    // resets — far worse than the spam this gate exists to stop.
    assert.equal(judgeOrigin(null).production, true);
    assert.equal(judgeOrigin(undefined).production, true);
    assert.equal(judgeOrigin('').production, true);
  });
});

describe('unconfigured allowlist', () => {
  test('still drops localhost when PRODUCTION_ORIGINS is empty', () => {
    delete process.env.PRODUCTION_ORIGINS;
    // A fresh deployment must not start emailing dev traffic just because the
    // allowlist has not been filled in yet.
    assert.equal(judgeOrigin('http://localhost:5173/').production, false);
    // ...but real hosts keep working so nothing breaks before configuration.
    assert.equal(judgeOrigin('https://medquiz.vercel.app/').production, true);
  });

  test('an unknown host is dropped once an allowlist exists', () => {
    process.env.PRODUCTION_ORIGINS = PROD;
    const v = judgeOrigin('https://someone-elses-site.com/');
    assert.equal(v.production, false);
    assert.equal('reason' in v && v.reason, 'not in PRODUCTION_ORIGINS');
  });
});
