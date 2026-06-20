import { describe, expect, it } from 'bun:test';
import { ttlMemo } from '../shared/ttl-memo';

// `bun test` sets NODE_ENV=test, which normally bypasses the memo entirely —
// every memo here opts back in via enableInTests to test the real behavior.

function counter<T>(value: (n: number) => T) {
  let calls = 0;
  return {
    loader: async (key: string) => {
      calls += 1;
      return value(calls);
    },
    get calls() {
      return calls;
    },
  };
}

describe('ttlMemo', () => {
  it('collapses repeat calls within the TTL to one loader invocation', async () => {
    const c = counter((n) => `v${n}`);
    const memo = ttlMemo({ ttlMs: 60_000, keyFn: (k: string) => k, loader: c.loader, enableInTests: true });
    expect(await memo('a')).toBe('v1');
    expect(await memo('a')).toBe('v1');
    expect(c.calls).toBe(1);
  });

  it('de-duplicates concurrent in-flight calls', async () => {
    let calls = 0;
    const memo = ttlMemo({
      ttlMs: 60_000,
      keyFn: (k: string) => k,
      loader: async (_k: string) => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return calls;
      },
      enableInTests: true,
    });
    const [a, b] = await Promise.all([memo('x'), memo('x')]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it('keeps keys independent', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({ ttlMs: 60_000, keyFn: (k: string) => k, loader: c.loader, enableInTests: true });
    expect(await memo('a')).toBe(1);
    expect(await memo('b')).toBe(2);
    expect(c.calls).toBe(2);
  });

  it('expires entries after the TTL', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({ ttlMs: 10, keyFn: (k: string) => k, loader: c.loader, enableInTests: true });
    expect(await memo('a')).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(await memo('a')).toBe(2);
  });

  it('never caches rejections', async () => {
    let calls = 0;
    const memo = ttlMemo({
      ttlMs: 60_000,
      keyFn: (k: string) => k,
      loader: async (_k: string) => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return 'ok';
      },
      enableInTests: true,
    });
    await expect(memo('a')).rejects.toThrow('boom');
    expect(await memo('a')).toBe('ok');
  });

  it('skips caching values rejected by shouldCache (negative results)', async () => {
    const c = counter((n) => (n === 1 ? null : 'member'));
    const memo = ttlMemo({
      ttlMs: 60_000,
      keyFn: (k: string) => k,
      loader: c.loader,
      shouldCache: (v) => v !== null,
      enableInTests: true,
    });
    expect(await memo('a')).toBeNull();
    // null was not cached — the next call re-loads and sees the grant.
    expect(await memo('a')).toBe('member');
    // The positive result IS cached.
    expect(await memo('a')).toBe('member');
    expect(c.calls).toBe(2);
  });

  it('ttlMs <= 0 disables caching entirely', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({ ttlMs: 0, keyFn: (k: string) => k, loader: c.loader, enableInTests: true });
    expect(await memo('a')).toBe(1);
    expect(await memo('a')).toBe(2);
  });

  it('evicts oldest entries past maxEntries', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({
      ttlMs: 60_000,
      keyFn: (k: string) => k,
      loader: c.loader,
      maxEntries: 2,
      enableInTests: true,
    });
    await memo('a'); // 1
    await memo('b'); // 2
    await memo('c'); // 3 — evicts 'a'
    expect(await memo('a')).toBe(4); // re-loaded
    expect(c.calls).toBe(4);
  });

  it('clear() drops all entries', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({ ttlMs: 60_000, keyFn: (k: string) => k, loader: c.loader, enableInTests: true });
    await memo('a');
    memo.clear();
    expect(await memo('a')).toBe(2);
  });
});
