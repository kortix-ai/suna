import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Queue-based db mock: each select() call shifts the next result set. Writes
// are captured for assertions. Conditions are real drizzle objects and are
// deliberately ignored — the queue controls what each query "finds", which
// keeps this file independent of drizzle internals and other files' mocks.

type Row = {
  accountId: string;
  id: string;
  email?: string | null;
  provider?: string | null;
  active?: boolean | null;
};

let selectResults: Row[][] = [];
let inserted: Row[] = [];
let updated: Array<Partial<Row>> = [];

function nextRows(): Row[] {
  return selectResults.shift() ?? [];
}

mock.module('../../shared/db', () => ({
  db: {
    select() {
      const rows = nextRows();
      return {
        from() {
          return {
            where() {
              return {
                limit(n: number) {
                  return Promise.resolve(rows.slice(0, n));
                },
                then(resolve: (value: Row[]) => unknown, reject?: (reason?: any) => unknown) {
                  return Promise.resolve(rows).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(data: Row) {
          return {
            async onConflictDoUpdate() {
              inserted.push({ ...data });
            },
          };
        },
      };
    },
    update() {
      return {
        set(data: Partial<Row>) {
          return {
            async where() {
              updated.push({ ...data });
            },
          };
        },
      };
    },
    delete() {
      return {
        async where() {},
      };
    },
  },
}));

const {
  getCustomerByAccountId,
  getCustomerByStripeId,
  listAccountStripeCustomerIds,
  upsertCustomer,
} = await import('../../billing/repositories/customers');

describe('billing customer repository', () => {
  beforeEach(() => {
    selectResults = [];
    inserted = [];
    updated = [];
  });

  test('resolves the canonical customer for an account', async () => {
    selectResults = [[{ accountId: 'acc_1', id: 'cus_1', provider: 'stripe', active: true }]];

    const customer = await getCustomerByAccountId('acc_1');

    expect(customer?.id).toBe('cus_1');
  });

  test('prefers an active stripe customer over inactive duplicates', async () => {
    selectResults = [[
      { accountId: 'acc_2', id: 'cus_inactive', provider: 'stripe', active: false },
      { accountId: 'acc_2', id: 'cus_active', provider: 'stripe', active: true },
    ]];

    const customer = await getCustomerByAccountId('acc_2');

    expect(customer?.id).toBe('cus_active');
  });

  test('returns null when the account has no customers', async () => {
    selectResults = [[]];

    expect(await getCustomerByAccountId('acc_none')).toBeNull();
  });

  test('upsertCustomer does not replace canonical customer mapping with new duplicate', async () => {
    // getCustomerByAccountId inside upsertCustomer finds the existing canonical row.
    selectResults = [[
      { accountId: 'acc_3', id: 'cus_old', email: 'user@example.com', provider: 'stripe', active: true },
    ]];

    const preserved = await upsertCustomer({
      accountId: 'acc_3',
      id: 'cus_new',
      email: 'user@example.com',
      provider: 'stripe',
      active: true,
    });

    expect(preserved?.id).toBe('cus_old');
    expect(inserted).toEqual([]); // the duplicate was NOT inserted
    expect(updated).toEqual([
      expect.objectContaining({ email: 'user@example.com', active: true }),
    ]);
  });

  test('upsertCustomer inserts when the account has no existing customer', async () => {
    selectResults = [[]];

    const created = await upsertCustomer({
      accountId: 'acc_4',
      id: 'cus_fresh',
      email: 'fresh@example.com',
      provider: 'stripe',
      active: true,
    });

    expect(created?.id).toBe('cus_fresh');
    expect(inserted).toEqual([expect.objectContaining({ id: 'cus_fresh', accountId: 'acc_4' })]);
  });

  test('looks up customers by stripe id', async () => {
    selectResults = [
      [{ accountId: 'acc_5', id: 'cus_by_id', provider: 'stripe', active: true }],
      [],
    ];

    expect((await getCustomerByStripeId('cus_by_id'))?.accountId).toBe('acc_5');
    expect(await getCustomerByStripeId('cus_missing')).toBeNull();
  });

  test('lists every stripe customer id, active and inactive', async () => {
    selectResults = [[
      { accountId: 'acc_6', id: 'cus_a', provider: 'stripe', active: true },
      { accountId: 'acc_6', id: 'cus_b', provider: 'stripe', active: false },
      { accountId: 'acc_6', id: 'cus_c', provider: 'other', active: true },
    ]];

    const ids = await listAccountStripeCustomerIds('acc_6');

    expect(ids.sort()).toEqual(['cus_a', 'cus_b']);
  });
});
