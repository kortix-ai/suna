import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, BillingError } from '@kortix/sdk';
import { getUpgradeGate } from './upgrade-gate.ts';

// The errors are the ones `@kortix/sdk` throws: a 402 is a `BillingError` whose
// `detail` carries the API body (`startProjectSessionOrThrow`, `backendApi`).

test('recognizes a subscription-required API response and preserves its account', () => {
  const error = new BillingError(402, {
    message: 'Subscribe to activate your seat.',
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
  const credits = new BillingError(402, {
    message: 'Out of credits. Top up to continue.',
    code: 'insufficient_credits',
  });
  const account = new BillingError(402, { message: 'Billing error', code: 'no_account' });

  assert.equal(getUpgradeGate(credits)?.reason, 'insufficient_credits');
  assert.equal(getUpgradeGate(account)?.reason, 'no_account');
});

test('does not turn unrelated API errors into upgrade prompts', () => {
  assert.equal(getUpgradeGate(new ApiError('Forbidden', { status: 403, code: 'subscription_required' })), null);
  assert.equal(getUpgradeGate(new BillingError(402, { message: 'Bad request', code: 'invalid_request' })), null);
  assert.equal(getUpgradeGate(new Error('Create a project before starting a sandbox')), null);
});
