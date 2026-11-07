// Real-PostgreSQL tests for Enterprise contract transitions and RevenueCat
// store lifecycle events, against a fake Stripe.
//
// Enterprise: an offer could be created while a contract was active (paying it
// could never activate); a withdrawn offer's Checkout sessions stayed payable;
// the contract status and `enterprise_entitled` were two writes, so a failure
// between them left one without the other.
// RevenueCat: EXPIRATION downgraded an account that bills through Stripe, and
// an expiration of an old product or an older period overwrote a newer plan.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { billingCustomers, creditAccounts, enterpriseContracts } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';

type FakeSession = { id: string; status: 'open' | 'complete' | 'expired'; metadata: Record<string, string> };
const sessions = new Map<string, FakeSession>();
const expired: string[] = [];

mock.module('../shared/stripe', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        list: async () => ({ data: [...sessions.values()].map((s) => ({ ...s })), has_more: false }),
        retrieve: async (id: string) => ({ ...sessions.get(id)! }),
        expire: async (id: string) => {
          expired.push(id);
          sessions.get(id)!.status = 'expired';
          return { ...sessions.get(id)! };
        },
      },
    },
    subscriptions: { cancel: async () => ({}) },
  }),
}));
mock.module('../shared/resolve-account', () => ({ resolveAccountId: async (userId: string) => userId }));

const { db } = await import('../shared/db');
const { createContract, withdrawOffer, endContract } = await import('../billing/services/enterprise-contracts');
const { processRevenueCatWebhook } = await import('../billing/services/revenuecat-webhooks');

const seeded: string[] = [];

async function seedAccount(values: Partial<typeof creditAccounts.$inferInsert> = {}): Promise<string> {
  const accountId = crypto.randomUUID();
  seeded.push(accountId);
  await db.insert(creditAccounts).values({ accountId, paymentStatus: 'active', ...values });
  return accountId;
}

async function contract(values: Partial<typeof enterpriseContracts.$inferInsert> & { accountId: string; status: string; collection: string }) {
  const [row] = await db
    .insert(enterpriseContracts)
    .values({ licenseUsd: '1000.00', creditsUsd: '0.00', ...values })
    .returning();
  return row!;
}

async function contractStatus(id: string): Promise<string> {
  const [row] = await db.select({ status: enterpriseContracts.status }).from(enterpriseContracts).where(eq(enterpriseContracts.id, id));
  return row!.status;
}

async function account(accountId: string) {
  const [row] = await db.select().from(creditAccounts).where(eq(creditAccounts.accountId, accountId));
  return row!;
}

/** Refuse every write to one account's credit row, to fail the entitlement half of a transition. */
async function refuseCreditWrites(accountId: string): Promise<() => Promise<void>> {
  const name = `test_refuse_${accountId.replaceAll('-', '')}`;
  await db.execute(
    sql.raw(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.account_id = '${accountId}' THEN RAISE EXCEPTION 'entitlement write refused'; END IF; RETURN NEW; END $$`),
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON kortix.credit_accounts FOR EACH ROW EXECUTE FUNCTION public.${name}()`),
  );
  return async () => {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON kortix.credit_accounts`));
    await db.execute(sql.raw(`DROP FUNCTION public.${name}()`));
  };
}

function rcEvent(type: string, accountId: string, extra: Record<string, unknown> = {}) {
  return { event: { id: crypto.randomUUID(), type, app_user_id: accountId, environment: 'PRODUCTION', ...extra } };
}

describe('Enterprise contracts and RevenueCat lifecycle (real PostgreSQL)', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  });

  afterAll(async () => {
    if (seeded.length === 0) return;
    await db.delete(enterpriseContracts).where(inArray(enterpriseContracts.accountId, seeded));
    await db.delete(billingCustomers).where(inArray(billingCustomers.accountId, seeded));
    await db.delete(creditAccounts).where(inArray(creditAccounts.accountId, seeded));
  });

  test('a checkout offer is refused while a contract is active', async () => {
    const accountId = await seedAccount();
    await contract({ accountId, status: 'active', collection: 'manual' });
    await expect(createContract({ accountId, licenseUsd: 500, collection: 'checkout' })).rejects.toMatchObject({ statusCode: 409 });
    const rows = await db.select().from(enterpriseContracts).where(eq(enterpriseContracts.accountId, accountId));
    expect(rows.map((row) => row.status)).toEqual(['active']);
  });

  test("withdrawing an offer expires every open Checkout session of that offer", async () => {
    const accountId = await seedAccount();
    const customer = `cus_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(billingCustomers).values({ accountId, id: customer, provider: 'stripe', active: true });
    const offer = await contract({ accountId, status: 'offered', collection: 'checkout', stripeCheckoutSessionId: 'cs_latest' });
    sessions.clear();
    expired.length = 0;
    sessions.set('cs_earlier', { id: 'cs_earlier', status: 'open', metadata: { contract_id: offer.id } });
    sessions.set('cs_latest', { id: 'cs_latest', status: 'open', metadata: { contract_id: offer.id } });
    sessions.set('cs_other', { id: 'cs_other', status: 'open', metadata: { contract_id: crypto.randomUUID() } });

    const row = await withdrawOffer(accountId, null);
    expect(row.status).toBe('withdrawn');
    expect(new Set(expired)).toEqual(new Set(['cs_earlier', 'cs_latest']));
  });

  test('an offer whose Checkout session is already paid is not withdrawn', async () => {
    const accountId = await seedAccount();
    const offer = await contract({ accountId, status: 'offered', collection: 'checkout', stripeCheckoutSessionId: 'cs_paid' });
    sessions.clear();
    sessions.set('cs_paid', { id: 'cs_paid', status: 'complete', metadata: { contract_id: offer.id } });
    await expect(withdrawOffer(accountId, null)).rejects.toMatchObject({ statusCode: 409 });
    expect(await contractStatus(offer.id)).toBe('offered');
  });

  test('activation commits the status and the entitlement together', async () => {
    const accountId = await seedAccount();
    const restore = await refuseCreditWrites(accountId);
    try {
      await expect(createContract({ accountId, licenseUsd: 100, collection: 'manual' })).rejects.toThrow();
    } finally {
      await restore();
    }
    const rows = await db.select().from(enterpriseContracts).where(eq(enterpriseContracts.accountId, accountId));
    expect(rows.map((row) => row.status)).toEqual(['offered']);
    expect((await account(accountId)).enterpriseEntitled).toBe(false);
  });

  test('ending commits the status and the entitlement together', async () => {
    const accountId = await seedAccount({ enterpriseEntitled: true });
    const active = await contract({ accountId, status: 'active', collection: 'manual' });
    const restore = await refuseCreditWrites(accountId);
    try {
      await expect(endContract(active.id, 'term_over')).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await contractStatus(active.id)).toBe('active');
    expect((await account(accountId)).enterpriseEntitled).toBe(true);
  });

  test('a store EXPIRATION does not downgrade an account that bills through Stripe', async () => {
    const accountId = await seedAccount({ tier: 'credits', provider: 'stripe', revenuecatProductId: 'kortix_credits_monthly' });
    await processRevenueCatWebhook(
      rcEvent('EXPIRATION', accountId, { product_id: 'kortix_credits_monthly', expiration_at_ms: Date.now() - 1000 }),
    );
    const row = await account(accountId);
    expect(row.tier).toBe('credits');
    expect(row.paymentStatus).toBe('active');
  });

  test('a store EXPIRATION of another product, or of a period older than the last renewal, changes nothing', async () => {
    const changed = await seedAccount({ tier: 'credits', provider: 'revenuecat', revenuecatProductId: 'kortix_credits_yearly' });
    await processRevenueCatWebhook(
      rcEvent('EXPIRATION', changed, { product_id: 'kortix_credits_monthly', expiration_at_ms: Date.now() - 1000 }),
    );
    expect((await account(changed)).tier).toBe('credits');

    const renewed = await seedAccount({
      tier: 'credits',
      provider: 'revenuecat',
      revenuecatProductId: 'kortix_credits_monthly',
      lastGrantDate: new Date().toISOString(),
    });
    await processRevenueCatWebhook(
      rcEvent('EXPIRATION', renewed, { product_id: 'kortix_credits_monthly', expiration_at_ms: Date.now() - 86_400_000 }),
    );
    expect((await account(renewed)).tier).toBe('credits');

    // The expiration of the current period still downgrades.
    const lapsed = await seedAccount({
      tier: 'credits',
      provider: 'revenuecat',
      revenuecatProductId: 'kortix_credits_monthly',
      lastGrantDate: new Date(Date.now() - 31 * 86_400_000).toISOString(),
    });
    await processRevenueCatWebhook(
      rcEvent('EXPIRATION', lapsed, { product_id: 'kortix_credits_monthly', expiration_at_ms: Date.now() - 1000 }),
    );
    const row = await account(lapsed);
    expect(row.tier).toBe('free');
    expect(row.paymentStatus).toBe('failed');
  });
});
