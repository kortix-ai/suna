import { describe, expect, test } from 'bun:test';
import { isBillingGateExemptPath, isUnauthenticatedBillingPath } from './index';

describe('billing auth skip', () => {
  test('webhook and cron prefixes skip auth', () => {
    for (const path of [
      '/v1/billing/webhooks/stripe',
      '/v1/billing/webhook/stripe',
      '/v1/billing/webhooks',
      '/v1/billing/cron/trial-expiry',
    ]) {
      expect(isUnauthenticatedBillingPath(path), path).toBe(true);
    }
  });

  test('substring look-alikes and ordinary routes keep auth', () => {
    for (const path of [
      '/v1/billing/checkout-session/webhook',
      '/v1/billing/checkout-session/webhooks/x',
      '/v1/billing/invoices/cron/x',
      '/v1/billing/webhooksx',
      '/v1/billing/subscription',
      '/v1/billing/account-state',
    ]) {
      expect(isUnauthenticatedBillingPath(path), path).toBe(false);
    }
  });

  test('gate exemption covers account-state, webhooks and cron only', () => {
    expect(isBillingGateExemptPath('/v1/billing/account-state')).toBe(true);
    expect(isBillingGateExemptPath('/v1/billing/webhooks/stripe')).toBe(true);
    expect(isBillingGateExemptPath('/v1/billing/cron/x')).toBe(true);
    expect(isBillingGateExemptPath('/v1/billing/subscription')).toBe(false);
  });
});
