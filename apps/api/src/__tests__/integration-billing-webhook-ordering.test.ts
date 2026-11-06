// Real-PostgreSQL tests for the order and the terminal states of the Stripe
// webhooks. Every event goes through `processStripeWebhook`, the handler the
// signed route calls, against a fake Stripe whose subscriptions hold the state
// Stripe would answer with NOW.
//
// What broke:
//   - `customer.subscription.updated` wrote the event's snapshot, so a delayed
//     older event overwrote the newer status;
//   - `invoice.payment_failed` marked the account past due for any of the
//     customer's subscriptions, and for a failure Stripe already recovered from;
//   - a late `checkout.session.completed` activated a subscription that had
//     ended since, and every activation replay turned auto top-up back on;
//   - account closure cancelled only the stored subscription, and the
//     closure's own `customer.subscription.deleted` adopted another live
//     subscription onto the closed account or wrote it back to `active`.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import {
  accountDeletionRequests,
  billingCustomers,
  creditAccounts,
  creditLedger,
  enterpriseContracts,
} from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';

type FakeSubscription = Record<string, any> & { id: string; customer: string; status: string };

const stripeSubscriptions = new Map<string, FakeSubscription>();
const cancelled: string[] = [];

const fakeStripe = {
  webhooks: { constructEvent: (raw: string) => JSON.parse(raw) },
  subscriptions: {
    retrieve: async (id: string) => {
      const sub = stripeSubscriptions.get(id);
      if (!sub) throw Object.assign(new Error(`No such subscription: ${id}`), { code: 'resource_missing' });
      return structuredClone(sub);
    },
    list: async ({ customer }: { customer: string }) => ({
      data: [...stripeSubscriptions.values()].filter((sub) => sub.customer === customer).map((sub) => structuredClone(sub)),
      has_more: false,
    }),
    cancel: async (id: string) => {
      cancelled.push(id);
      const sub = stripeSubscriptions.get(id);
      if (sub) sub.status = 'canceled';
      return sub ?? {};
    },
    update: async (id: string, params: Record<string, unknown>) => ({ ...stripeSubscriptions.get(id), ...params }),
  },
};

mock.module('../shared/stripe', () => ({ getStripe: () => fakeStripe }));
mock.module('../shared/supabase', () => ({
  toPublicStorageUrl: (url: string) => url,
  getSupabase: () => ({
    auth: { admin: { deleteUser: async () => ({ error: null }) } },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
  }),
}));

const { db } = await import('../shared/db');
const { processStripeWebhook } = await import('../billing/services/webhooks');
const { processScheduledDeletions } = await import('../billing/services/account-deletion');

const accountsSeeded: string[] = [];
const NOW = Math.floor(Date.now() / 1000);

function subscription(id: string, accountId: string, customer: string, status: string): FakeSubscription {
  return {
    id,
    object: 'subscription',
    customer,
    status,
    cancel_at_period_end: false,
    billing_cycle_anchor: NOW,
    current_period_start: NOW,
    current_period_end: NOW + 30 * 86_400,
    metadata: { account_id: accountId },
    items: {
      data: [{ id: `si_${id}`, quantity: 1, price: { id: 'price_ordering_test', unit_amount: 2000, recurring: { interval: 'month' } } }],
    },
  };
}

async function send(type: string, object: unknown, created = NOW): Promise<void> {
  const event = { id: `evt_${crypto.randomUUID()}`, type, created, data: { object } };
  await processStripeWebhook(JSON.stringify(event), 'signature-ignored-by-fake');
}

async function seedAccount(values: Partial<typeof creditAccounts.$inferInsert>): Promise<string> {
  const accountId = crypto.randomUUID();
  accountsSeeded.push(accountId);
  await db.insert(creditAccounts).values({ accountId, provider: 'stripe', paymentStatus: 'active', ...values });
  return accountId;
}

async function account(accountId: string) {
  const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  return row!;
}

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

describe('Stripe webhooks: order and terminal states (real PostgreSQL)', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  });

  afterAll(async () => {
    if (accountsSeeded.length === 0) return;
    await db.delete(creditLedger).where(inArray(creditLedger.accountId, accountsSeeded));
    await db.delete(enterpriseContracts).where(inArray(enterpriseContracts.accountId, accountsSeeded));
    await db.delete(billingCustomers).where(inArray(billingCustomers.accountId, accountsSeeded));
    await db.delete(accountDeletionRequests).where(inArray(accountDeletionRequests.accountId, accountsSeeded));
    await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, accountsSeeded));
  });

  for (const order of ['newer first', 'older first'] as const) {
    test(`subscription.updated events in either order end on the live status (${order})`, async () => {
      const subId = id('sub');
      const customer = id('cus');
      const accountId = await seedAccount({ tier: 'credits', stripeSubscriptionId: subId, stripeSubscriptionStatus: 'active' });
      // Stripe now: the subscription recovered and is active.
      stripeSubscriptions.set(subId, subscription(subId, accountId, customer, 'active'));
      const older = { ...subscription(subId, accountId, customer, 'past_due') };
      const newer = { ...subscription(subId, accountId, customer, 'active') };
      const events: Array<[unknown, number]> =
        order === 'newer first' ? [[newer, NOW], [older, NOW - 100]] : [[older, NOW - 100], [newer, NOW]];
      for (const [object, created] of events) await send('customer.subscription.updated', object, created);
      expect((await account(accountId)).stripeSubscriptionStatus).toBe('active');
    });
  }

  test('invoice.payment_failed for another subscription, or one Stripe already recovered, leaves the account as it is', async () => {
    const current = id('sub');
    const legacy = id('sub');
    const customer = id('cus');
    const accountId = await seedAccount({ tier: 'credits', stripeSubscriptionId: current, stripeSubscriptionStatus: 'active' });
    stripeSubscriptions.set(current, subscription(current, accountId, customer, 'active'));
    stripeSubscriptions.set(legacy, subscription(legacy, accountId, customer, 'past_due'));

    await send('invoice.payment_failed', { id: id('in'), object: 'invoice', subscription: legacy });
    expect((await account(accountId)).paymentStatus).toBe('active');

    // A failure of the current subscription that a retry already paid.
    await send('invoice.payment_failed', { id: id('in'), object: 'invoice', subscription: current });
    expect((await account(accountId)).paymentStatus).toBe('active');

    // A failure that holds now is recorded.
    stripeSubscriptions.get(current)!.status = 'past_due';
    await send('invoice.payment_failed', { id: id('in'), object: 'invoice', subscription: current });
    expect((await account(accountId)).paymentStatus).toBe('past_due');
  });

  test('a late checkout.session.completed for an ended subscription activates nothing', async () => {
    const subId = id('sub');
    const customer = id('cus');
    const accountId = await seedAccount({
      tier: 'free',
      stripeSubscriptionId: subId,
      stripeSubscriptionStatus: 'canceled',
      autoTopupEnabled: false,
    });
    stripeSubscriptions.set(subId, subscription(subId, accountId, customer, 'canceled'));
    await send('checkout.session.completed', {
      id: id('cs'),
      object: 'checkout.session',
      mode: 'subscription',
      subscription: subId,
      customer,
      payment_status: 'paid',
      metadata: { account_id: accountId, plan_key: 'credits' },
    });
    const row = await account(accountId);
    expect(row.tier).toBe('free');
    expect(row.autoTopupEnabled).toBe(false);
    const grants = await db.select().from(creditLedger).where(eq(creditLedger.accountId, accountId));
    expect(grants).toEqual([]);
  });

  test('an activation replay keeps auto top-up off when the customer turned it off', async () => {
    const subId = id('sub');
    const customer = id('cus');
    const accountId = await seedAccount({
      tier: 'credits',
      stripeSubscriptionId: subId,
      stripeSubscriptionStatus: 'active',
      autoTopupEnabled: false,
    });
    stripeSubscriptions.set(subId, subscription(subId, accountId, customer, 'active'));
    await send('checkout.session.completed', {
      id: id('cs'),
      object: 'checkout.session',
      mode: 'subscription',
      subscription: subId,
      customer,
      payment_status: 'paid',
      metadata: { account_id: accountId, plan_key: 'credits' },
    });
    expect((await account(accountId)).autoTopupEnabled).toBe(false);
  });

  test('a closed account stays closed: subscription.deleted and .updated neither revive it nor adopt another subscription', async () => {
    const stored = id('sub');
    const other = id('sub');
    const customer = id('cus');
    const accountId = await seedAccount({
      tier: 'free',
      stripeSubscriptionId: stored,
      stripeSubscriptionStatus: 'canceled',
      paymentStatus: 'deleted',
    });
    stripeSubscriptions.set(stored, subscription(stored, accountId, customer, 'canceled'));
    stripeSubscriptions.set(other, subscription(other, accountId, customer, 'active'));

    await send('customer.subscription.deleted', subscription(stored, accountId, customer, 'canceled'));
    await send('customer.subscription.updated', subscription(other, accountId, customer, 'active'));

    const row = await account(accountId);
    expect(row.paymentStatus).toBe('deleted');
    expect(row.tier).toBe('free');
    expect(row.stripeSubscriptionId).toBe(stored);
  });

  test('closure cancels every live subscription of the customer, ends the contract, and its own webhook keeps it closed', async () => {
    const plan = id('sub');
    const legacy = id('sub');
    const contractSub = id('sub');
    const ended = id('sub');
    const customer = id('cus');
    const accountId = await seedAccount({
      tier: 'credits',
      stripeSubscriptionId: plan,
      stripeSubscriptionStatus: 'active',
      enterpriseEntitled: true,
    });
    await db.insert(billingCustomers).values({ accountId, id: customer, provider: 'stripe', active: true });
    for (const [subId, status] of [[plan, 'active'], [legacy, 'past_due'], [contractSub, 'active'], [ended, 'canceled']] as const) {
      stripeSubscriptions.set(subId, subscription(subId, accountId, customer, status));
    }
    const [contract] = await db
      .insert(enterpriseContracts)
      .values({
        accountId,
        status: 'active',
        licenseUsd: '1000.00',
        creditsUsd: '0.00',
        collection: 'invoice',
        stripeSubscriptionId: contractSub,
      })
      .returning({ id: enterpriseContracts.id });
    // A team account (not the requester's personal one): no login is deleted.
    await db.insert(accountDeletionRequests).values({
      accountId,
      userId: crypto.randomUUID(),
      scheduledFor: new Date(Date.now() - 3_600_000).toISOString(),
      status: 'pending',
    });
    cancelled.length = 0;

    const result = await processScheduledDeletions();
    expect(result.errors).toEqual([]);

    expect(new Set(cancelled)).toEqual(new Set([plan, legacy, contractSub]));
    const [contractAfter] = await db.select().from(enterpriseContracts).where(eq(enterpriseContracts.id, contract!.id));
    expect(contractAfter!.status).toBe('ended');
    let row = await account(accountId);
    expect(row.paymentStatus).toBe('deleted');
    expect(row.stripeSubscriptionId).toBeNull();
    expect(row.enterpriseEntitled).toBe(false);

    // The closure's own cancel comes back as subscription.deleted.
    await send('customer.subscription.deleted', subscription(plan, accountId, customer, 'canceled'));
    row = await account(accountId);
    expect(row.paymentStatus).toBe('deleted');
    expect(row.tier).toBe('free');
  }, 30_000);
});
