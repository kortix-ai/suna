import { describe, expect, it, mock } from 'bun:test';

// The registry's group/account helpers query the DB for member ids; stub a
// minimal select().from().where() chain so this stays a pure unit test.
let nextMemberRows: Array<{ userId: string }> = [];
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => nextMemberRows,
      }),
    }),
  },
  hasDatabase: () => false,
}));

const {
  registerPrincipalScopedMemo,
  invalidateIamCacheForUser,
  invalidateIamCacheForUsers,
  invalidateIamCacheForAccount,
} = await import('../iam/cache-invalidation');

describe('iam cache-invalidation registry', () => {
  it('busts every registered memo with the `${userId}|` prefix', () => {
    const seen: string[] = [];
    registerPrincipalScopedMemo({ invalidateByPrefix: (p) => seen.push(`a:${p}`) });
    registerPrincipalScopedMemo({ invalidateByPrefix: (p) => seen.push(`b:${p}`) });
    invalidateIamCacheForUser('u1');
    expect(seen).toContain('a:u1|');
    expect(seen).toContain('b:u1|');
  });

  it('null / empty userId is a no-op (never bust the whole cache)', () => {
    const seen: string[] = [];
    registerPrincipalScopedMemo({ invalidateByPrefix: (p) => seen.push(p) });
    invalidateIamCacheForUser(null);
    invalidateIamCacheForUser(undefined);
    invalidateIamCacheForUser('');
    expect(seen).toEqual([]);
  });

  it('invalidateIamCacheForUsers busts each user', () => {
    const seen: string[] = [];
    registerPrincipalScopedMemo({ invalidateByPrefix: (p) => seen.push(p) });
    invalidateIamCacheForUsers(['x', null, 'y']);
    expect(seen).toContain('x|');
    expect(seen).toContain('y|');
    // the null is skipped — only two prefixes from this memo
    expect(seen.filter((p) => p === 'x|' || p === 'y|')).toHaveLength(2);
  });

  it('invalidateIamCacheForAccount busts every member of the account (e.g. after an mfa-required flip)', async () => {
    const seen: string[] = [];
    registerPrincipalScopedMemo({ invalidateByPrefix: (p) => seen.push(p) });
    nextMemberRows = [{ userId: 'acct-member-1' }, { userId: 'acct-member-2' }];

    await invalidateIamCacheForAccount('acct-1');

    expect(seen).toContain('acct-member-1|');
    expect(seen).toContain('acct-member-2|');
  });

  it('invalidateIamCacheForAccount is a no-op for a null/undefined accountId', async () => {
    const seen: string[] = [];
    registerPrincipalScopedMemo({ invalidateByPrefix: (p) => seen.push(p) });
    nextMemberRows = [{ userId: 'should-not-be-seen' }];

    await invalidateIamCacheForAccount(null);
    await invalidateIamCacheForAccount(undefined);

    expect(seen).toEqual([]);
  });
});
