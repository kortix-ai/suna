/**
 * DB suite: the legacy Stripe recovery never adopts another workspace's
 * subscription (design.md §3.1 finding 8). Real schema and wallet; Stripe is
 * an in-memory fake that records every call, so "Stripe unchanged" is an
 * assertion on its write log.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { accounts, billingCustomers, creditAccounts, creditLedger } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../../shared/db';
import { resolveCreditsPriceId } from './tiers';

type FakeSubscription = {
  id: string;
  customer: string;
  status: string;
  metadata: Record<string, string>;
  billing_cycle_anchor: number;
  current_period_end: number;
  items: { data: Array<{ quantity: number; price: { id: string; unit_amount: number; recurring: { interval: string } } }> };
};

const stripe = {
  subscriptions: [] as FakeSubscription[],
  updates: [] as Array<{ id: string; metadata: Record<string, string> }>,
  emailSearches: 0,
  // Every customer the fake account holds; all of one person's carry one email.
  customers: [] as Array<{ id: string; email: string }>,
};

const realStripe = await import('../../shared/stripe');
mock.module('../../shared/stripe', () => ({
  ...realStripe,
  getStripe: () => ({
    customers: {
      retrieve: async (id: string) => ({ id, deleted: false }),
      search: async ({ query }: { query: string }) => {
        stripe.emailSearches += 1;
        const email = /email:'([^']+)'/.exec(query)?.[1];
        return { data: stripe.customers.filter((c) => c.email === email) };
      },
    },
    subscriptions: {
      list: async ({ customer, status }: { customer: string; status: string }) => ({
        data: stripe.subscriptions.filter((s) => s.customer === customer && s.status === status),
      }),
      search: async ({ query }: { query: string }) => {
        const named = /metadata\['account_id'\]:'([^']+)'/.exec(query)?.[1];
        return { data: stripe.subscriptions.filter((s) => s.status === 'active' && s.metadata.account_id === named) };
      },
      update: async (id: string, { metadata }: { metadata: Record<string, string> }) => {
        stripe.updates.push({ id, metadata });
        const sub = stripe.subscriptions.find((s) => s.id === id)!;
        sub.metadata = metadata;
        return sub;
      },
    },
  }),
}));

const { syncLegacyStripeSubscription } = await import('./legacy-stripe-sync');

const created: string[] = [];
const EMAIL = 'one-person@example.test';

async function workspace(name: string, customerId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  created.push(id);
  await db.insert(accounts).values({ accountId: id, name });
  await db.insert(creditAccounts).values({ accountId: id, tier: 'free' });
  if (customerId) {
    await db.insert(billingCustomers).values({ accountId: id, id: customerId, email: EMAIL, active: true, provider: 'stripe' });
    stripe.customers.push({ id: customerId, email: EMAIL });
  }
  return id;
}

function subscription(id: string, customer: string, metadata: Record<string, string>): FakeSubscription {
  const sub: FakeSubscription = {
    id,
    customer,
    status: 'active',
    metadata,
    billing_cycle_anchor: Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000),
    current_period_end: Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000),
    items: { data: [{ quantity: 5000, price: { id: resolveCreditsPriceId(), unit_amount: 1, recurring: { interval: 'month' } } }] },
  };
  stripe.subscriptions.push(sub);
  return sub;
}

async function plan(accountId: string) {
  const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  return { tier: row?.tier, sub: row?.stripeSubscriptionId ?? null };
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

beforeEach(() => {
  stripe.subscriptions.length = 0;
  stripe.updates.length = 0;
  stripe.emailSearches = 0;
  stripe.customers.length = 0;
});

afterAll(async () => {
  await db.delete(creditLedger).where(inArray(creditLedger.accountId, created));
  await db.delete(billingCustomers).where(inArray(billingCustomers.accountId, created));
  await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, created));
  await db.delete(accounts).where(inArray(accounts.accountId, created));
});

describe('legacy Stripe sync never crosses workspaces', () => {
  test("one person, two workspaces, one email, one paid: the sync on the unpaid one adopts nothing and Stripe is unchanged", async () => {
    const paidCustomer = uid('cus_paid');
    const unpaid = await workspace('Unpaid workspace', uid('cus_unpaid'));
    const paid = await workspace('Paid workspace', paidCustomer);
    const sub = subscription(uid('sub'), paidCustomer, { account_id: paid });
    await db.update(creditAccounts).set({ tier: 'credits', stripeSubscriptionId: sub.id }).where(eq(creditAccounts.accountId, paid));

    const result = await syncLegacyStripeSubscription(unpaid);

    expect(result.status).toBe('no_active_paid_subscription');
    expect(stripe.updates).toEqual([]);
    expect(stripe.emailSearches).toBe(0);
    expect(await plan(unpaid)).toEqual({ tier: 'free', sub: null });
    expect(sub.metadata).toEqual({ account_id: paid });
  });

  test("a subscription on this account's own customer whose metadata names another live workspace is not adopted", async () => {
    const customer = uid('cus_own');
    const other = await workspace('Other live workspace', null);
    const mine = await workspace('My workspace', customer);
    subscription(uid('sub'), customer, { account_id: other });

    expect((await syncLegacyStripeSubscription(mine)).status).toBe('no_active_paid_subscription');
    expect(stripe.updates).toEqual([]);
    expect(await plan(mine)).toEqual({ tier: 'free', sub: null });
  });

  test('a subscription another credit_accounts row already holds is refused (I11)', async () => {
    const customer = uid('cus_own');
    const holder = await workspace('Holder', null);
    const mine = await workspace('Mine', customer);
    const sub = subscription(uid('sub'), customer, {});
    await db.update(creditAccounts).set({ stripeSubscriptionId: sub.id }).where(eq(creditAccounts.accountId, holder));

    expect((await syncLegacyStripeSubscription(mine)).status).toBe('no_active_paid_subscription');
    expect(stripe.updates).toEqual([]);
  });

  test("this account's own customer with empty metadata: adopted, metadata names this account", async () => {
    const customer = uid('cus_own');
    const mine = await workspace('Recovered', customer);
    const sub = subscription(uid('sub'), customer, {});

    const result = await syncLegacyStripeSubscription(mine);

    expect(result).toMatchObject({ status: 'synced', subscriptionId: sub.id, customerId: customer });
    expect(stripe.updates).toHaveLength(1);
    expect(stripe.updates[0]!.metadata).toMatchObject({ account_id: mine, plan_key: 'credits', tier_key: 'credits' });
    expect(await plan(mine)).toEqual({ tier: 'credits', sub: sub.id });
  });

  test('an unmapped customer whose subscription names this account: adopted and mapped to it', async () => {
    const customer = uid('cus_unmapped');
    const mine = await workspace('Unmapped customer', null);
    const sub = subscription(uid('sub'), customer, { account_id: mine });

    expect((await syncLegacyStripeSubscription(mine)).status).toBe('synced');
    expect(await plan(mine)).toEqual({ tier: 'credits', sub: sub.id });
    const [mapped] = await db.select().from(billingCustomers).where(eq(billingCustomers.id, customer));
    expect(mapped?.accountId).toBe(mine);
  });

  test("an unmapped customer mapped to another account is that account's, even when its subscription names this one", async () => {
    const customer = uid('cus_theirs');
    await workspace('Owner of the customer', customer);
    const mine = await workspace('Not the owner', null);
    subscription(uid('sub'), customer, { account_id: mine });

    expect((await syncLegacyStripeSubscription(mine)).status).toBe('no_active_paid_subscription');
    expect(stripe.updates).toEqual([]);
  });

  test('metadata naming an account that no longer exists is a legacy id: adopted, the old id kept', async () => {
    const customer = uid('cus_own');
    const mine = await workspace('Legacy recovery', customer);
    const gone = crypto.randomUUID();
    subscription(uid('sub'), customer, { account_id: gone });

    expect((await syncLegacyStripeSubscription(mine)).status).toBe('synced');
    expect(stripe.updates[0]!.metadata).toMatchObject({ account_id: mine, legacy_account_id: gone });
  });
});
