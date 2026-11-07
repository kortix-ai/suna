import { beforeEach, describe, expect, mock, test } from 'bun:test';
import Stripe from 'stripe';

let processResult: () => Promise<unknown>;

mock.module('../../billing/services/webhooks', () => ({
  processStripeWebhook: () => processResult(),
  processRevenueCatWebhook: async () => ({ received: true }),
}));

mock.module('../../config', () => ({
  config: { STRIPE_WEBHOOK_SECRET: 'whsec_test', REVENUECAT_WEBHOOK_SECRET: 'rc_test' },
}));

const { webhooksRouter } = await import('../../billing/routes/webhooks');

const post = () =>
  webhooksRouter.request('/stripe', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, body: '{}' });

describe('POST /stripe webhook route', () => {
  beforeEach(() => {
    processResult = async () => ({ received: true });
  });

  test('a Stripe rate limit answers 503 with Retry-After so Stripe redelivers', async () => {
    processResult = async () => {
      throw new Stripe.errors.StripeRateLimitError({ message: 'Request rate limit exceeded', type: 'invalid_request_error' });
    };
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  test('any other error still propagates as a failure', async () => {
    processResult = async () => {
      throw new Error('boom');
    };
    const res = await post();
    expect(res.status).toBe(500);
  });

  test('success returns 200', async () => {
    const res = await post();
    expect(res.status).toBe(200);
  });
});
