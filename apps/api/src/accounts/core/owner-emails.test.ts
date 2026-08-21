import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

interface ExecuteCall {
  ids: string[];
}

const state = {
  calls: [] as ExecuteCall[],
  rows: [] as Array<{ id: string; email: string | null }>,
  fail: false,
};

// Render the SQL through drizzle's own dialect so a test can assert
// "one statement, N bound parameters" instead of just "one call".
const dialect = new PgDialect();
function paramsOf(query: unknown): string[] {
  const { params } = dialect.sqlToQuery(query as SQL);
  return params.filter((p): p is string => typeof p === 'string');
}

mock.module('../../shared/db', () => ({
  db: {
    execute: async (query: unknown) => {
      state.calls.push({ ids: paramsOf(query) });
      if (state.fail) throw new Error('auth.users unreachable');
      return state.rows;
    },
  },
  hasDatabase: true,
}));

const { clearOwnerEmailCache, lookupEmailsByUserIds, OWNER_EMAIL_TTL_MS, ownerEmailCacheSize } =
  await import('./owner-emails');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  state.calls = [];
  state.rows = [];
  state.fail = false;
  clearOwnerEmailCache();
});

describe('lookupEmailsByUserIds', () => {
  test('issues no query for an empty id list', async () => {
    const result = await lookupEmailsByUserIds([]);
    expect(result.size).toBe(0);
    expect(state.calls).toHaveLength(0);
  });

  test('resolves N ids with ONE query, not one call per id', async () => {
    state.rows = [
      { id: A, email: 'a@example.com' },
      { id: B, email: 'b@example.com' },
      { id: C, email: 'c@example.com' },
    ];
    const result = await lookupEmailsByUserIds([A, B, C]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.ids).toEqual([A, B, C]);
    expect(result.get(A)).toBe('a@example.com');
    expect(result.get(B)).toBe('b@example.com');
    expect(result.get(C)).toBe('c@example.com');
  });

  test('deduplicates repeated ids into a single placeholder each', async () => {
    state.rows = [{ id: A, email: 'a@example.com' }];
    const result = await lookupEmailsByUserIds([A, A, A]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.ids).toEqual([A]);
    expect(result.get(A)).toBe('a@example.com');
  });

  test('a warm cache serves repeat lookups with zero queries', async () => {
    state.rows = [{ id: A, email: 'a@example.com' }];
    await lookupEmailsByUserIds([A]);
    expect(state.calls).toHaveLength(1);

    const cached = await lookupEmailsByUserIds([A]);
    expect(state.calls).toHaveLength(1);
    expect(cached.get(A)).toBe('a@example.com');
  });

  test('queries only the ids that are not already cached', async () => {
    state.rows = [{ id: A, email: 'a@example.com' }];
    await lookupEmailsByUserIds([A]);

    state.rows = [{ id: B, email: 'b@example.com' }];
    const result = await lookupEmailsByUserIds([A, B]);
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1]?.ids).toEqual([B]);
    expect(result.get(A)).toBe('a@example.com');
    expect(result.get(B)).toBe('b@example.com');
  });

  test('caches unknown ids as null so a deleted user is not re-queried', async () => {
    state.rows = [];
    const first = await lookupEmailsByUserIds([A]);
    expect(first.get(A)).toBeNull();
    expect(state.calls).toHaveLength(1);

    await lookupEmailsByUserIds([A]);
    expect(state.calls).toHaveLength(1);
  });

  test('re-queries once the TTL expires', async () => {
    const t0 = 1_000_000;
    state.rows = [{ id: A, email: 'a@example.com' }];
    await lookupEmailsByUserIds([A], t0);
    expect(state.calls).toHaveLength(1);

    await lookupEmailsByUserIds([A], t0 + OWNER_EMAIL_TTL_MS - 1);
    expect(state.calls).toHaveLength(1);

    state.rows = [{ id: A, email: 'renamed@example.com' }];
    const fresh = await lookupEmailsByUserIds([A], t0 + OWNER_EMAIL_TTL_MS + 1);
    expect(state.calls).toHaveLength(2);
    expect(fresh.get(A)).toBe('renamed@example.com');
  });

  test('a failed lookup degrades to null and does NOT poison the cache', async () => {
    state.fail = true;
    const result = await lookupEmailsByUserIds([A]);
    expect(result.get(A)).toBeNull();
    expect(ownerEmailCacheSize()).toBe(0);

    // The next call must retry rather than serve a cached null.
    state.fail = false;
    state.rows = [{ id: A, email: 'a@example.com' }];
    const retry = await lookupEmailsByUserIds([A]);
    expect(state.calls).toHaveLength(2);
    expect(retry.get(A)).toBe('a@example.com');
  });
});
