import { expect, mock, test } from 'bun:test';

const offer = { id: 'contract_synthetic', accountId: 'acct_synthetic', collection: 'checkout', termMonths: 12, licenseUsd: '1200.50', creditsUsd: '300.25' };
const sessions: Array<{ params: unknown; options: unknown }> = [];
const writes: unknown[] = [];
mock.module('../../shared/db', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [offer] }) }) }),
  update: () => ({ set: (patch: unknown) => { writes.push(patch); return { where: async () => undefined }; } }),
} }));
mock.module('../../shared/stripe', () => ({ getStripe: () => ({
  products: { search: async ({ query }: { query: string }) => ({ data: [{ id: query.includes('enterprise_license') ? 'prod_license' : 'prod_credits' }] }) },
  checkout: { sessions: { create: async (params: unknown, options: unknown) => {
    sessions.push({ params, options }); return { id: 'cs_synthetic', url: 'https://example.test/checkout' };
  } } },
}) }));
mock.module('./subscriptions', () => ({ getOrCreateStripeCustomer: async () => 'cus_synthetic' }));
const { createOfferCheckout } = await import('./enterprise-contracts');

test('offer checkout preserves annual prices and contract metadata while disabling Link on Basil', async () => {
  expect(await createOfferCheckout({ accountId: offer.accountId, email: 'billing@example.test', successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' }))
    .toEqual({ checkout_url: 'https://example.test/checkout', contract_id: offer.id });
  const metadata = { account_id: offer.accountId, plan_key: 'enterprise', contract_id: offer.id };
  expect(sessions).toEqual([{
    params: {
      customer: 'cus_synthetic', mode: 'subscription',
      line_items: [
        { quantity: 1, price_data: { currency: 'usd', product: 'prod_license', unit_amount: 120050, recurring: { interval: 'month', interval_count: 12 } } },
        { quantity: 1, price_data: { currency: 'usd', product: 'prod_credits', unit_amount: 30025, recurring: { interval: 'month', interval_count: 12 } } },
      ],
      success_url: 'https://example.test/success', cancel_url: 'https://example.test/cancel',
      payment_method_collection: 'always', subscription_data: { metadata }, metadata,
      wallet_options: { link: { display: 'never' } },
    },
    options: { apiVersion: '2025-04-30.basil' },
  }]);
  expect(writes).toEqual([{ stripeCheckoutSessionId: 'cs_synthetic', updatedAt: expect.any(String) }]);
});
