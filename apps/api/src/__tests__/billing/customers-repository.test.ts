import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Row = {
  accountId: string;
  id: string;
  email?: string | null;
  provider?: string | null;
  active?: boolean | null;
};

let kortixRows: Row[] = [];
let basejumpRows: Row[] = [];

const billingCustomers = {
  __table: 'kortix.billing_customers',
  accountId: { field: 'accountId' },
  id: { field: 'id' },
  provider: { field: 'provider' },
  active: { field: 'active' },
};

const billingCustomersInBasejump = {
  __table: 'basejump.billing_customers',
  accountId: { field: 'accountId' },
  id: { field: 'id' },
  provider: { field: 'provider' },
  active: { field: 'active' },
};

function matches(row: Row, condition: any): boolean {
  if (!condition) return true;
  if (condition.op === 'and') return condition.conditions.every((c: any) => matches(row, c));
  if (condition.op === 'eq') return row[condition.field as keyof Row] === condition.value;
  if (condition.op === 'ne') return row[condition.field as keyof Row] !== condition.value;
  return true;
}

function makeQuery(rows: Row[]) {
  return {
    limit(n: number) {
      return Promise.resolve(rows.slice(0, n));
    },
    then(resolve: (value: Row[]) => unknown, reject?: (reason?: any) => unknown) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
}

mock.module('drizzle-orm', () => ({
  eq: (left: any, value: any) => ({ op: 'eq', field: left.field, value }),
  ne: (left: any, value: any) => ({ op: 'ne', field: left.field, value }),
  and: (...conditions: any[]) => ({ op: 'and', conditions }),
}));

mock.module('@kortix/db', () => ({
  billingCustomers,
  billingCustomersInBasejump,
}));

mock.module('../../shared/db', () => ({
  db: {
    select() {
      return {
        from(table: any) {
          const source = table.__table === 'basejump.billing_customers' ? basejumpRows : kortixRows;
          return {
            where(condition: any) {
              return makeQuery(source.filter((row) => matches(row, condition)));
            },
          };
        },
      };
    },
    insert(table: any) {
      const source = table.__table === 'basejump.billing_customers' ? basejumpRows : kortixRows;
      return {
        values(data: Row) {
          return {
            async onConflictDoUpdate({ target, set }: any) {
              const idField = target.field as keyof Row;
              const index = source.findIndex((row) => row[idField] === data[idField]);
              if (index >= 0) {
                source[index] = { ...source[index], ...set };
              } else {
                source.push({ ...data });
              }
            },
          };
        },
      };
    },
    update(table: any) {
      const source = table.__table === 'basejump.billing_customers' ? basejumpRows : kortixRows;
      return {
        set(data: Partial<Row>) {
          return {
            async where(condition: any) {
              source.forEach((row, index) => {
                if (matches(row, condition)) source[index] = { ...row, ...data };
              });
            },
          };
        },
      };
    },
  },
}));

const {
  getCustomerByAccountId,
  getCustomerByStripeId,
  upsertCustomer,
} = await import('../../billing/repositories/customers');

describe('billing customer repository', () => {
  beforeEach(() => {
    kortixRows = [];
    basejumpRows = [];
  });

  test('falls back to basejump and lazy-migrates legacy customer', async () => {
    basejumpRows.push({
      accountId: 'acc_1',
      id: 'cus_legacy',
      email: 'legacy@example.com',
      provider: 'stripe',
      active: true,
    });

    const customer = await getCustomerByAccountId('acc_1');

    expect(customer?.id).toBe('cus_legacy');
    expect(kortixRows).toEqual([
      expect.objectContaining({ accountId: 'acc_1', id: 'cus_legacy', provider: 'stripe', active: true }),
    ]);
  });

  test('prefers legacy customer over wrong kortix duplicate and deactivates duplicate', async () => {
    basejumpRows.push({
      accountId: 'acc_2',
      id: 'cus_old',
      email: 'user@example.com',
      provider: 'stripe',
      active: true,
    });
    kortixRows.push({
      accountId: 'acc_2',
      id: 'cus_new',
      email: 'user@example.com',
      provider: 'stripe',
      active: true,
    });

    const customer = await getCustomerByAccountId('acc_2');

    expect(customer?.id).toBe('cus_old');
    expect(kortixRows.find((row) => row.id === 'cus_old')?.active).toBe(true);
    expect(kortixRows.find((row) => row.id === 'cus_new')?.active).toBe(false);
  });

  test('upsertCustomer does not replace canonical customer mapping with new duplicate', async () => {
    basejumpRows.push({
      accountId: 'acc_3',
      id: 'cus_old',
      email: 'user@example.com',
      provider: 'stripe',
      active: true,
    });

    const preserved = await upsertCustomer({
      accountId: 'acc_3',
      id: 'cus_new',
      email: 'user@example.com',
      provider: 'stripe',
      active: true,
    });

    expect(preserved?.id).toBe('cus_old');
    expect(kortixRows.find((row) => row.id === 'cus_new')).toBeUndefined();
    expect(kortixRows.find((row) => row.id === 'cus_old')?.active).toBe(true);
  });

  test('falls back by stripe id to legacy customer and lazy-migrates it', async () => {
    basejumpRows.push({
      accountId: 'acc_4',
      id: 'cus_legacy_by_id',
      email: 'legacy@example.com',
      provider: 'stripe',
      active: true,
    });

    const customer = await getCustomerByStripeId('cus_legacy_by_id');

    expect(customer?.accountId).toBe('acc_4');
    expect(kortixRows.find((row) => row.id === 'cus_legacy_by_id')?.accountId).toBe('acc_4');
  });
});
