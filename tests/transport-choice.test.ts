import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTransport, mailDomainFor } from '../lib/transport-choice.ts';
import type { TransportName } from '../lib/types.ts';

const allowAll = (_t: TransportName) => true;
const base = { dryRun: false, hint: null, allowed: allowAll, resendAvailable: true, resend2Configured: true, resend2Available: true };

describe('transport choice with a second Resend account', () => {
  test('account 1 carries the mail while it has budget', () => {
    assert.equal(chooseTransport(base), 'resend');
  });

  test('when account 1 is spent, account 2 takes over before Gmail', () => {
    assert.equal(chooseTransport({ ...base, resendAvailable: false }), 'resend2');
  });

  test('when both accounts are spent, Gmail carries it', () => {
    assert.equal(chooseTransport({ ...base, resendAvailable: false, resend2Available: false }), 'gmail');
  });

  test('without a second account configured, behaviour is unchanged (Gmail after account 1)', () => {
    assert.equal(chooseTransport({ ...base, resendAvailable: false, resend2Configured: false }), 'gmail');
    assert.equal(chooseTransport({ ...base, resend2Configured: false }), 'resend');
  });

  test('a project not allowed to use resend never lands on resend2', () => {
    const noResend = (t: TransportName) => t !== 'resend' && t !== 'resend2';
    assert.equal(chooseTransport({ ...base, resendAvailable: false, allowed: noResend }), 'gmail');
  });

  test('dry run and explicit hints win over quota', () => {
    assert.equal(chooseTransport({ ...base, dryRun: true }), 'noop');
    assert.equal(chooseTransport({ ...base, hint: 'gmail' }), 'gmail');
  });

  test('when nothing else is possible, account 1 is the last resort (it answers with a quota error)', () => {
    const onlyResend = (t: TransportName) => t === 'resend';
    assert.equal(chooseTransport({ ...base, resendAvailable: false, resend2Available: false, allowed: onlyResend }), 'resend');
  });
});

describe('mail domain per Resend account', () => {
  test('each account sends only from the domain it verified', () => {
    const env = { MAIL_DOMAIN: 'smle-question-bank.com', MAIL_DOMAIN_2: 'alshraky.xyz' };
    assert.equal(mailDomainFor('resend', env), 'smle-question-bank.com');
    assert.equal(mailDomainFor('resend2', env), 'alshraky.xyz');
    assert.equal(mailDomainFor('gmail', env), 'smle-question-bank.com');
  });

  test('without MAIL_DOMAIN_2 the second lane falls back to the first domain, never to nothing', () => {
    assert.equal(mailDomainFor('resend2', { MAIL_DOMAIN: 'smle-question-bank.com' }), 'smle-question-bank.com');
  });
});
