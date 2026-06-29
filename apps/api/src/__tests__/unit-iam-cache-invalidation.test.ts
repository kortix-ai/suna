import { describe, expect, it, mock } from 'bun:test';

// The registry's group helper imports db; stub it so this stays a pure unit test
// (the user/registry paths under test never touch the DB).
mock.module('../shared/db', () => ({ db: {}, hasDatabase: () => false }));

const { registerPrincipalScopedMemo, invalidateIamCacheForUser, invalidateIamCacheForUsers } = await import(
  '../iam/cache-invalidation'
);

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
});
