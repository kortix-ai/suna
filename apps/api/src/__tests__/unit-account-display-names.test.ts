import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Account display names must fall back to the account OWNER's email, not the
// caller's — otherwise every unnamed account a user is invited into renders
// as "<caller>'s Account" and shared projects look like they live in the
// caller's personal account.

let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'orderBy', 'set', 'values', 'returning']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain(), update: () => makeChain(), insert: () => makeChain(), execute: async () => [] },
  hasDatabase: () => true,
}));

// Emails looked up via the Supabase admin API (owner ids → emails).
let emailsById: Record<string, string> = {};
mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async (uid: string) => ({ data: { user: emailsById[uid] ? { email: emailsById[uid] } : null } }),
      },
    },
  }),
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => 'acc-x',
}));

const {
  accountDisplayName,
  properAccountName,
  resolveAccountDisplayNames,
} = await import('../accounts/core/app');

const CALLER = { userId: 'u-caller', email: 'marko@kortix.ai' };

beforeEach(() => {
  dbResults = [];
  emailsById = {};
});

describe('properAccountName / accountDisplayName', () => {
  test('placeholder names are not proper names', () => {
    expect(properAccountName('Personal')).toBeNull();
    expect(properAccountName('User')).toBeNull();
    expect(properAccountName('  ')).toBeNull();
    expect(properAccountName(null)).toBeNull();
    expect(properAccountName('Acme Corp')).toBe('Acme Corp');
  });

  test('accountDisplayName falls back to email-derived name', () => {
    expect(accountDisplayName('Personal', 'a@b.com')).toBe("a@b.com's Account");
    expect(accountDisplayName('Acme', 'a@b.com')).toBe('Acme');
    expect(accountDisplayName(null, null)).toBe('Account');
  });
});

describe('resolveAccountDisplayNames', () => {
  test('keeps proper names without touching owners', async () => {
    const names = await resolveAccountDisplayNames(
      [{ accountId: 'a1', name: 'Acme Corp' }],
      CALLER,
    );
    expect(names.get('a1')).toBe('Acme Corp');
  });

  test("unnamed account owned by the caller → caller's email", async () => {
    dbResults = [[{ accountId: 'a1', userId: 'u-caller' }]];
    const names = await resolveAccountDisplayNames(
      [{ accountId: 'a1', name: 'Personal' }],
      CALLER,
    );
    expect(names.get('a1')).toBe("marko@kortix.ai's Account");
  });

  test("unnamed account owned by someone else → OWNER's email, not the caller's", async () => {
    dbResults = [[{ accountId: 'a1', userId: 'u-owner' }]];
    emailsById = { 'u-owner': 'bob@example.com' };
    const names = await resolveAccountDisplayNames(
      [{ accountId: 'a1', name: 'Personal' }],
      CALLER,
    );
    expect(names.get('a1')).toBe("bob@example.com's Account");
  });

  test('multiple owners → earliest-joined owner wins (first row)', async () => {
    dbResults = [[
      { accountId: 'a1', userId: 'u-first' },
      { accountId: 'a1', userId: 'u-second' },
    ]];
    emailsById = { 'u-first': 'first@example.com', 'u-second': 'second@example.com' };
    const names = await resolveAccountDisplayNames(
      [{ accountId: 'a1', name: '' }],
      CALLER,
    );
    expect(names.get('a1')).toBe("first@example.com's Account");
  });

  test("no owner rows → caller's email as last resort", async () => {
    dbResults = [[]];
    const names = await resolveAccountDisplayNames(
      [{ accountId: 'a1', name: 'User' }],
      CALLER,
    );
    expect(names.get('a1')).toBe("marko@kortix.ai's Account");
  });

  test('owner whose email cannot be resolved → caller email fallback', async () => {
    dbResults = [[{ accountId: 'a1', userId: 'u-ghost' }]];
    const names = await resolveAccountDisplayNames(
      [{ accountId: 'a1', name: 'Personal' }],
      CALLER,
    );
    expect(names.get('a1')).toBe("marko@kortix.ai's Account");
  });

  test('mixed batch resolves each account independently', async () => {
    dbResults = [[
      { accountId: 'a2', userId: 'u-owner' },
    ]];
    emailsById = { 'u-owner': 'owner@example.com' };
    const names = await resolveAccountDisplayNames(
      [
        { accountId: 'a1', name: 'Acme Corp' },
        { accountId: 'a2', name: 'Personal' },
      ],
      CALLER,
    );
    expect(names.get('a1')).toBe('Acme Corp');
    expect(names.get('a2')).toBe("owner@example.com's Account");
  });
});
