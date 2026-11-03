import { beforeEach, expect, mock, test } from 'bun:test';

let memberships: { accountId: string }[] = [];
let reads: unknown[][] = [];
let pages: { has_more: boolean; data: unknown[] }[] = [];
mock.module('../iam/membership-read', () => ({ userAccountRows: async () => memberships }));
mock.module('../shared/db', () => ({ db: { select: () => ({ from: () => ({ where: async () => reads.shift() ?? [] }) }) } }));
mock.module('../shared/stripe', () => ({ getStripe: () => ({ subscriptions: { list: async () => {
  const page = pages.shift();
  if (!page) throw new Error('synthetic unavailable');
  return page;
} } }) }));
const { lookupSalesCustomer, enrichSalesCustomer } = await import('./sales-customer-lookup');
const billing = { provider: 'stripe', trialStatus: 'none' };
const customer = { provider: 'stripe', id: 'cus_synthetic' };
function subscription(amount: number, status = 'active') {
  return { status, current_period_end: 4070908800, items: { has_more: false, data: [{ price: { unit_amount: amount } }] } };
}
beforeEach(() => { memberships = []; reads = []; pages = []; });
test('missing membership or billing mapping is unknown', async () => {
  expect(await lookupSalesCustomer('synthetic')).toBeNull();
  memberships = [{ accountId: 'synthetic' }];
  expect(await lookupSalesCustomer('synthetic')).toBeNull();
});
test('fresh Stripe evidence distinguishes zero-dollar, paid minor-unit, and lapsed subscriptions', async () => {
  for (const [amount, status, expected] of [[0, 'active', false], [1, 'active', true], [50, 'canceled', false]] as const) {
    memberships = [{ accountId: 'synthetic' }];
    reads = [[], [billing], [customer]];
    pages = [{ has_more: false, data: [subscription(amount, status)] }];
    expect(await lookupSalesCustomer('synthetic')).toBe(expected);
  }
});
test('missing canonical subscription from Stripe response cannot prove negative', async () => {
  memberships = [{ accountId: 'synthetic' }];
  reads = [[], [{ ...billing, stripeSubscriptionId: 'sub_missing' }], [customer]];
  pages = [{ has_more: false, data: [subscription(0)] }];
  expect(await lookupSalesCustomer('synthetic')).toBeNull();
});
test('partial pagination and Stripe outages cannot prove negative', async () => {
  memberships = [{ accountId: 'synthetic' }];
  reads = [[], [billing], [customer]];
  pages = [{ has_more: true, data: [subscription(0)] }];
  expect(await lookupSalesCustomer('synthetic')).toBeNull();
  reads = [[], [billing], [customer]];
  expect(await lookupSalesCustomer('synthetic')).toBeNull();
});
test('stale active subscription evidence remains unknown', async () => {
  memberships = [{ accountId: 'synthetic' }];
  reads = [[], [billing], [customer]];
  pages = [{ has_more: false, data: [{ ...subscription(0), current_period_end: 1 }] }];
  expect(await lookupSalesCustomer('synthetic')).toBeNull();
});
test('one paid membership overrides unsupported membership', async () => {
  memberships = [{ accountId: 'first' }, { accountId: 'second' }];
  reads = [[], [{ ...billing, provider: 'revenuecat' }], [], [], [billing], [customer]];
  pages = [{ has_more: false, data: [subscription(50)] }];
  expect(await lookupSalesCustomer('synthetic')).toBe(true);
});
test('current paid contract overrides all incomplete Stripe evidence; expired contract does not', async () => {
  memberships = [{ accountId: 'synthetic' }];
  const contract = { status: 'active', licenseUsd: '100.00', startsAt: '2020-01-01', endsAt: '2099-01-01' };
  reads = [[contract]];
  expect(await lookupSalesCustomer('synthetic')).toBe(true);
  reads = [[{ ...contract, endsAt: '2021-01-01' }], [billing], [customer]];
  pages = [{ has_more: false, data: [subscription(0)] }];
  expect(await lookupSalesCustomer('synthetic')).toBeNull();
});
test('enrichment replaces stale negative truth from latest authoritative source', async () => {
  memberships = [{ accountId: 'synthetic' }];
  reads = [[], [billing], [customer]];
  pages = [{ has_more: false, data: [subscription(50)] }];
  expect(await enrichSalesCustomer({ type: 'account.signup', data: { user_id: 'synthetic', is_customer: false } })).toMatchObject({ data: { is_customer: true } });
});
