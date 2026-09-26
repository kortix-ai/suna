// The Stripe customer mapping on PostgreSQL: which `billing_customers` row is
// an account's canonical customer, how an upsert keeps one active mapping per
// provider, and the lookups every Stripe webhook resolves an account through.
import { beforeEach, describe, expect, test } from 'bun:test';
import { billingCustomers } from '@kortix/db';
import { asc, eq } from 'drizzle-orm';
import { seedAccount } from '../../__tests__/helpers/integration-fixtures';
import { db } from '../../shared/db';
import {
  getCustomerByAccountId,
  getCustomerByStripeId,
  listAccountStripeCustomerIds,
  upsertCustomer,
} from './customers';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

type Row = { id: string; active: boolean | null; provider: string | null };

async function seed(accountId: string, rows: Row[]) {
  await db.insert(billingCustomers).values(rows.map((row) => ({ accountId, email: null, ...row })));
}

async function rowsOf(accountId: string) {
  return db
    .select({ id: billingCustomers.id, active: billingCustomers.active, provider: billingCustomers.provider })
    .from(billingCustomers)
    .where(eq(billingCustomers.accountId, accountId))
    .orderBy(asc(billingCustomers.id));
}

withDb('billing customer mapping', () => {
  let accountId: string;
  let otherAccountId: string;

  beforeEach(async () => {
    accountId = await seedAccount('billing-customers');
    otherAccountId = await seedAccount('billing-customers-other');
  });

  test('an active Stripe customer wins over inactive duplicates and other providers', async () => {
    const suffix = accountId.slice(0, 8);
    await seed(accountId, [
      { id: `cus_a_${suffix}`, active: false, provider: 'stripe' },
      { id: `cus_b_${suffix}`, active: true, provider: 'stripe' },
      { id: `rc_a_${suffix}`, active: true, provider: 'revenuecat' },
    ]);

    expect((await getCustomerByAccountId(accountId))?.id).toBe(`cus_b_${suffix}`);
  });

  test('an account with no customer rows has no canonical customer', async () => {
    await seed(otherAccountId, [{ id: `cus_${otherAccountId.slice(0, 8)}`, active: true, provider: 'stripe' }]);

    expect(await getCustomerByAccountId(accountId)).toBeNull();
  });

  test('an upsert with a new id keeps the canonical customer and inserts nothing', async () => {
    const suffix = accountId.slice(0, 8);
    await seed(accountId, [{ id: `cus_old_${suffix}`, active: true, provider: 'stripe' }]);

    const kept = await upsertCustomer({ accountId, id: `cus_new_${suffix}`, email: 'billing@example.test', provider: 'stripe' });

    expect(kept.id).toBe(`cus_old_${suffix}`);
    expect(await rowsOf(accountId)).toEqual([{ id: `cus_old_${suffix}`, active: true, provider: 'stripe' }]);
  });

  test('an account without a customer gets one active row', async () => {
    const id = `cus_first_${accountId.slice(0, 8)}`;

    await upsertCustomer({ accountId, id, email: 'billing@example.test', provider: 'stripe', active: true });

    expect(await rowsOf(accountId)).toEqual([{ id, active: true, provider: 'stripe' }]);
  });

  test('re-asserting the canonical customer deactivates every other row of that provider on that account only', async () => {
    const suffix = accountId.slice(0, 8);
    await seed(accountId, [
      { id: `cus_a_${suffix}`, active: true, provider: 'stripe' },
      { id: `cus_b_${suffix}`, active: true, provider: 'stripe' },
      { id: `rc_a_${suffix}`, active: true, provider: 'revenuecat' },
    ]);
    await seed(otherAccountId, [{ id: `cus_x_${suffix}`, active: true, provider: 'stripe' }]);

    await upsertCustomer({ accountId, id: `cus_a_${suffix}`, provider: 'stripe', active: true });

    expect(await rowsOf(accountId)).toEqual([
      { id: `cus_a_${suffix}`, active: true, provider: 'stripe' },
      { id: `cus_b_${suffix}`, active: false, provider: 'stripe' },
      { id: `rc_a_${suffix}`, active: true, provider: 'revenuecat' },
    ]);
    expect(await rowsOf(otherAccountId)).toEqual([{ id: `cus_x_${suffix}`, active: true, provider: 'stripe' }]);
  });

  test('a Stripe customer id resolves to its account, and an unknown id to nothing', async () => {
    const id = `cus_lookup_${accountId.slice(0, 8)}`;
    await seed(accountId, [{ id, active: false, provider: 'stripe' }]);

    expect((await getCustomerByStripeId(id))?.accountId).toBe(accountId);
    expect(await getCustomerByStripeId(`cus_missing_${accountId.slice(0, 8)}`)).toBeNull();
  });

  test('every Stripe customer id of the account is listed, active or not', async () => {
    const suffix = accountId.slice(0, 8);
    await seed(accountId, [
      { id: `cus_live_${suffix}`, active: true, provider: 'stripe' },
      { id: `cus_old_${suffix}`, active: false, provider: 'stripe' },
      { id: `rc_${suffix}`, active: true, provider: 'revenuecat' },
    ]);
    await seed(otherAccountId, [{ id: `cus_other_${suffix}`, active: true, provider: 'stripe' }]);

    expect((await listAccountStripeCustomerIds(accountId)).sort()).toEqual([
      `cus_live_${suffix}`,
      `cus_old_${suffix}`,
    ]);
  });
});
