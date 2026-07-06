import { describe, test, expect } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { apiKeys } from './public';

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
