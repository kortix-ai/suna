import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createApiRequestError,
  getUpgradeGate,
} from './upgrade-gate.ts';

test('recognizes a subscription-required API response and preserves its account', () => {
  const error = createApiRequestError(402, {
    error: 'Subscribe to activate your seat.',
    code: 'subscription_required',
    account_id: 'account-team',
  });

  assert.deepEqual(getUpgradeGate(error), {
    reason: 'subscription_required',
    accountId: 'account-team',
    message: 'Subscribe to activate your seat.',
  });
});

test('recognizes exhausted-credit and missing-account billing gates', () => {
  const credits = createApiRequestError(402, {
    message: 'Out of credits. Top up to continue.',
    code: 'insufficient_credits',
  });
  const account = createApiRequestError(402, {
    code: 'no_account',
  });

  assert.equal(getUpgradeGate(credits)?.reason, 'insufficient_credits');
  assert.equal(getUpgradeGate(account)?.reason, 'no_account');
});

test('does not turn unrelated API errors into upgrade prompts', () => {
  assert.equal(getUpgradeGate(createApiRequestError(403, { code: 'subscription_required' })), null);
  assert.equal(getUpgradeGate(createApiRequestError(402, { code: 'invalid_request' })), null);
  assert.equal(getUpgradeGate(new Error('Create a project before starting a sandbox')), null);
});
