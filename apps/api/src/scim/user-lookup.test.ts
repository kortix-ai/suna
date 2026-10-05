import { beforeEach, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const state = {
  rows: [] as Array<{ id: string }>,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  failure: false,
};

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    execute: async (query: SQL) => {
      state.queries.push(dialect.sqlToQuery(query));
      if (state.failure) throw new Error('directory unavailable');
      return state.rows;
    },
  },
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({ auth: { admin: {
    listUsers: async () => ({ data: {
      users: Array.from({ length: 1000 }, (_, i) => ({ id: `other-${i}`, email: `other-${i}@example.com` })),
    } }),
  } } }),
}));

const { userIdByEmail } = await import('./app');

beforeEach(() => {
  state.rows = [];
  state.queries = [];
  state.failure = false;
});

test('finds a user outside the first 1000 auth users with one exact lookup', async () => {
  state.rows = [{ id: 'matched-user' }];
  expect(await userIdByEmail('  EXISTING@example.com  ', 'account-id')).toBe('matched-user');
  expect(state.queries).toHaveLength(1);
  expect(state.queries[0]!.params).toContain('existing@example.com');
  expect(state.queries[0]!.params).toContain('account-id');
  expect(state.queries[0]!.sql).toMatch(/where u\.email =/i);
  expect(state.queries[0]!.sql).toMatch(/order by \(m\.user_id is not null\) desc/i);
});

test('returns null only when the lookup finds no matching user', async () => {
  expect(await userIdByEmail('missing@example.com')).toBeNull();
  expect(state.queries).toHaveLength(1);
});

test('does not turn a failed directory lookup into an invitation', async () => {
  state.failure = true;
  await expect(userIdByEmail('existing@example.com')).rejects.toThrow('directory unavailable');
});

test('skips blank email lookups', async () => {
  expect(await userIdByEmail('  ')).toBeNull();
  expect(state.queries).toHaveLength(0);
});
