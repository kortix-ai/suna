import { describe, test, expect } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { apiKeys, accountUser, billingCustomersInBasejump } from './public';

function primaryColumns(table: any): string[] {
  const cfg = getTableConfig(table);
  const inline = cfg.columns.filter((c) => c.primary).map((c) => c.name);
  const composite = cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name));
  return [...inline, ...composite];
}

describe('public api_keys table', () => {
  test('maps to the public api_keys table name', () => {
    const cfg = getTableConfig(apiKeys);
    expect(cfg.name).toBe('api_keys');
    expect(cfg.schema).toBeUndefined();
  });

  test('uses key_id as its primary key', () => {
    expect(primaryColumns(apiKeys)).toEqual(['key_id']);
  });

  test('public_key and secret_key_hash are not null', () => {
    const cols = getTableConfig(apiKeys).columns;
    expect(cols.find((c) => c.name === 'public_key')?.notNull).toBe(true);
    expect(cols.find((c) => c.name === 'secret_key_hash')?.notNull).toBe(true);
  });

  test('status defaults to active', () => {
    const col = getTableConfig(apiKeys).columns.find((c) => c.name === 'status');
    expect(col?.default).toBe('active');
  });

  test('defines account and public key lookup indexes', () => {
    const idx = getTableConfig(apiKeys).indexes.map((i) => i.config.name);
    expect(idx).toContain('idx_api_keys_account_id');
    expect(idx).toContain('idx_api_keys_public_key');
  });
});

describe('basejump account_user table', () => {
  test('lives in the basejump schema', () => {
    expect(getTableConfig(accountUser).schema).toBe('basejump');
  });

  test('declares a composite primary key on user_id and account_id', () => {
    expect(primaryColumns(accountUser)).toEqual(['user_id', 'account_id']);
  });

  test('account_role is not null', () => {
    const col = getTableConfig(accountUser).columns.find((c) => c.name === 'account_role');
    expect(col?.notNull).toBe(true);
  });
});

describe('basejump billing_customers table', () => {
  test('lives in the basejump schema with the expected name', () => {
    const cfg = getTableConfig(billingCustomersInBasejump);
    expect(cfg.schema).toBe('basejump');
    expect(cfg.name).toBe('billing_customers');
  });

  test('uses id as its primary key', () => {
    expect(primaryColumns(billingCustomersInBasejump)).toEqual(['id']);
  });

  test('account_id is not null', () => {
    const col = getTableConfig(billingCustomersInBasejump).columns.find(
      (c) => c.name === 'account_id',
    );
    expect(col?.notNull).toBe(true);
  });
});
