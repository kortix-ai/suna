import { expect, mock, test } from 'bun:test';

const offer = { id: 'contract_synthetic', accountId: 'acct_synthetic', collection: 'checkout', termMonths: 12, licenseUsd: '1200.50', creditsUsd: '300.25' };
const sessions: Array<{ params: unknown; options: unknown }> = [];
const writes: unknown[] = [];
const searches: string[] = [];
const products: unknown[] = [];
const invoices: unknown[] = [];
mock.module('../../shared/db', () => ({ withDbTransaction: <T>(fn: () => Promise<T>) => fn(), db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => offer.collection === 'invoice' ? [] : [offer] }) }) }),
  insert: () => ({ values: () => ({ returning: async () => [offer] }) }),
  // A status write is a compare-and-set that reads its row back (`.returning()`).
  update: () => ({ set: (patch: unknown) => { writes.push(patch); return { where: () => Object.assign(Promise.resolve(undefined), { returning: async () => [] }) }; } }),
} }));
mock.module('../../shared/stripe', () => ({ getStripe: () => ({
  products: {
    search: async ({ query }: { query: string }) => { searches.push(query); return { data: [] }; },
    create: async (params: unknown) => { products.push(params); return { id: 'prod_license' }; },
  },
  subscriptions: { create: async (params: unknown) => { invoices.push(params); throw new Error('captured invoice'); } },
  checkout: { sessions: { create: async (params: unknown, options: unknown) => {
    sessions.push({ params, options }); return { id: 'cs_synthetic', url: 'https://example.test/checkout' };
  } } },
}) }));
mock.module('./subscriptions', () => ({ getOrCreateStripeCustomer: async () => 'cus_synthetic' }));
mock.module('../../iam/read-models', () => ({ accountRoleMap: async () => new Map([['user_synthetic', 'owner']]) }));
mock.module('../../accounts/core/owner-emails', () => ({ lookupEmailsByUserIds: async () => new Map([['user_synthetic', 'billing@example.test']]) }));
const { createOfferCheckout, createContract } = await import('./enterprise-contracts');
test('offer checkout charges the license only (a stale credits amount is ignored), keeps contract metadata and disables Link on Basil', async () => {
  expect(await createOfferCheckout({ accountId: offer.accountId, email: 'billing@example.test', successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' }))
    .toEqual({ checkout_url: 'https://example.test/checkout', contract_id: offer.id });
  const metadata = { account_id: offer.accountId, plan_key: 'enterprise', contract_id: offer.id };
  expect(sessions).toEqual([{
    params: {
      customer: 'cus_synthetic', mode: 'subscription',
      line_items: [
        { quantity: 1, price_data: { currency: 'usd', product: 'prod_license', unit_amount: 120050, recurring: { interval: 'month', interval_count: 12 } } },
      ],
      success_url: `https://example.test/success?accountId=${offer.accountId}&accountTab=billing`, cancel_url: 'https://example.test/cancel',
      payment_method_collection: 'always', subscription_data: { metadata }, metadata,
      wallet_options: { link: { display: 'never' } },
    },
    options: { apiVersion: '2025-04-30.basil' },
  }]);
  expect(writes).toEqual([{ stripeCheckoutSessionId: 'cs_synthetic', updatedAt: expect.any(String) }]);
});
test('a product search miss creates one license product and reuses it for later checkouts', async () => {
  await createOfferCheckout({ accountId: offer.accountId, email: 'billing@example.test', successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' });
  expect(searches).toEqual(["metadata['kortix_product']:'enterprise_license'"]); expect(products).toEqual([{ name: 'Kortix Enterprise license', metadata: { kortix_product: 'enterprise_license' } }]); expect(sessions).toHaveLength(2);
});
test('a zero-dollar license creates no line items or product', async () => {
  offer.licenseUsd = '0.00';
  await createOfferCheckout({ accountId: offer.accountId, email: 'billing@example.test', successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' });
  expect(sessions[2]?.params).toMatchObject({ line_items: [] }); expect(products).toHaveLength(1);
});
test('invoice collection uses license price_data without credits', async () => {
  offer.collection = 'invoice'; offer.licenseUsd = '1200.50';
  await expect(createContract({ accountId: offer.accountId, licenseUsd: 1200.50, collection: 'invoice' })).rejects.toThrow('captured invoice');
  expect(invoices).toEqual([{ customer: 'cus_synthetic', collection_method: 'send_invoice', days_until_due: 30, items: [{ price_data: { currency: 'usd', product: 'prod_license', unit_amount: 120050, recurring: { interval: 'month', interval_count: 12 } } }], metadata: { account_id: offer.accountId, plan_key: 'enterprise', contract_id: offer.id } }]);
});
