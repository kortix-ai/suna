import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
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

  it('passes the loader args to shouldCache so a memo can decide per key', async () => {
    // resource-grants: an EMPTY grant map is cached for open-by-default types
    // (skill) but never for closed-by-default ones (agent), so a fresh agent
    // grant is visible on every replica within one request instead of one TTL.
    let loads = 0;
    const memo = ttlMemo({
      ttlMs: 60_000,
      keyFn: (projectId: string, resourceType: string) => `${projectId}|${resourceType}`,
      loader: async (_projectId: string, _resourceType: string) => {
        loads += 1;
        return new Map<string, string[]>();
      },
      shouldCache: (map, _projectId, resourceType) => map.size > 0 || resourceType !== 'agent',
      enableInTests: true,
    });
    await memo('p1', 'agent');
    await memo('p1', 'agent');
    expect(loads).toBe(2); // empty agent map: never cached
    await memo('p1', 'skill');
    await memo('p1', 'skill');
    expect(loads).toBe(3); // empty skill map: cached
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

  it('invalidate(key) drops only that entry (others survive)', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({ ttlMs: 60_000, keyFn: (k: string) => k, loader: c.loader, enableInTests: true });
    await memo('a'); // 1
    await memo('b'); // 2
    memo.invalidate('a');
    expect(await memo('a')).toBe(3); // re-loaded
    expect(await memo('b')).toBe(2); // untouched
  });

  it('invalidateByPrefix() drops every entry under the prefix', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({ ttlMs: 60_000, keyFn: (k: string) => k, loader: c.loader, enableInTests: true });
    await memo('u1|acct'); // 1
    await memo('u1|proj'); // 2
    await memo('u2|acct'); // 3
    memo.invalidateByPrefix('u1|');
    expect(await memo('u1|acct')).toBe(4); // re-loaded
    expect(await memo('u1|proj')).toBe(5); // re-loaded
    expect(await memo('u2|acct')).toBe(3); // different principal — untouched
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve the nth pending loader call, so the test never casts a non-null. */
function resolvePending(resolvers: Array<(v: number) => void>, index: number, value: number) {
  const resolve = resolvers[index];
  if (!resolve) throw new Error(`no pending loader at index ${index}`);
  resolve(value);
}

/**
 * Stale-while-revalidate (2026-09-28, KRTX-620). `ttlMemo` is the shared
 * primitive the `/projects/:id/sandbox-health` poll uses. Its 10 s TTL expires
 * long before the client's next poll (120 s idle), so the live provider probe
 * ran on nearly every request and the route's p95 tracked the provider's tail.
 * SWR serves the last resolved value at once and refreshes behind it.
 */
describe('ttlMemo stale-while-revalidate', () => {
  // A 10 ms TTL on the wall clock expires again between a refresh settling and
  // the next assertion on a loaded CI runner. Tests that assert "fresh again"
  // drive Date.now() instead, so only the explicit advance() moves time.
  let clock = 0;
  const freezeClock = () => setSystemTime(new Date((clock = Date.now())));
  const advance = (ms: number) => setSystemTime(new Date((clock += ms)));
  afterEach(() => setSystemTime());

  it('serves the stale value immediately and refreshes behind the call', async () => {
    let calls = 0;
    const resolvers: Array<(v: number) => void> = [];
    const memo = ttlMemo({
      ttlMs: 10,
      staleWhileRevalidate: true,
      keyFn: (k: string) => k,
      loader: (_k: string) => {
        calls += 1;
        return new Promise<number>((resolve) => resolvers.push(resolve));
      },
      enableInTests: true,
    });
    freezeClock();

    const first = memo('a');
    resolvePending(resolvers, 0, 1);
    expect(await first).toBe(1);

    advance(25); // TTL expires, the value is now stale
    // The call returns the stale 1 without waiting on the refresh (which will
    // resolve to 2) — the provider round trip is off the request path.
    expect(await memo('a')).toBe(1);
    expect(calls).toBe(2); // refresh started in the background

    resolvePending(resolvers, 1, 2);
    await sleep(0);
    expect(await memo('a')).toBe(2); // fresh again
    expect(calls).toBe(2); // no third load
  });

  it('starts at most one refresh per key while one is in flight', async () => {
    let calls = 0;
    const resolvers: Array<(v: number) => void> = [];
    const memo = ttlMemo({
      ttlMs: 5,
      staleWhileRevalidate: true,
      keyFn: (k: string) => k,
      loader: (_k: string) => {
        calls += 1;
        return new Promise<number>((resolve) => resolvers.push(resolve));
      },
      enableInTests: true,
    });

    const first = memo('a');
    resolvePending(resolvers, 0, 1);
    expect(await first).toBe(1);

    await sleep(15);
    expect(await memo('a')).toBe(1); // refresh #2 in flight
    await sleep(15); // TTL passed again but #2 has not settled
    expect(await memo('a')).toBe(1); // served stale, no third load
    expect(calls).toBe(2);
  });

  it('keeps serving the last good value when a refresh fails, then retries', async () => {
    let calls = 0;
    const memo = ttlMemo({
      ttlMs: 10,
      staleWhileRevalidate: true,
      keyFn: (k: string) => k,
      loader: async (_k: string) => {
        calls += 1;
        if (calls === 2) throw new Error('provider down');
        return calls;
      },
      enableInTests: true,
    });
    freezeClock();

    expect(await memo('a')).toBe(1);
    advance(25);
    expect(await memo('a')).toBe(1); // stale kept; refresh #2 rejects
    advance(25);
    expect(await memo('a')).toBe(1); // stale served; refresh #3 retries
    await sleep(0); // let refresh #3 settle
    expect(await memo('a')).toBe(3); // fresh now
    expect(calls).toBe(3);
  });

  it('shares a still-pending load instead of starting a second one after the TTL', async () => {
    let calls = 0;
    const resolvers: Array<(v: number) => void> = [];
    const memo = ttlMemo({
      ttlMs: 5,
      staleWhileRevalidate: true,
      keyFn: (k: string) => k,
      loader: (_k: string) => {
        calls += 1;
        return new Promise<number>((resolve) => resolvers.push(resolve));
      },
      enableInTests: true,
    });

    const p1 = memo('a');
    await sleep(15); // TTL passed while the first load is still pending
    const p2 = memo('a');
    expect(calls).toBe(1); // one in-flight load, not two
    resolvePending(resolvers, 0, 42);
    expect(await p1).toBe(42);
    expect(await p2).toBe(42);
  });

  it('a refresh that settles after its own TTL still buys a full window', async () => {
    // The 5f2ae97 runner failure: freshness was reset at refresh START, so a
    // refresh slower than the TTL left the entry expired the moment its fresh
    // value landed and the next call started another background load.
    // Freshness restarts at SETTLE, so the late refresh must buy a full TTL.
    let calls = 0;
    const resolvers: Array<(v: number) => void> = [];
    const memo = ttlMemo({
      ttlMs: 10,
      staleWhileRevalidate: true,
      keyFn: (k: string) => k,
      loader: (_k: string) => {
        calls += 1;
        return new Promise<number>((resolve) => resolvers.push(resolve));
      },
      enableInTests: true,
    });
    freezeClock();

    const first = memo('a');
    resolvePending(resolvers, 0, 1);
    expect(await first).toBe(1);

    advance(25); // TTL expires; refresh #2 starts
    expect(await memo('a')).toBe(1);
    expect(calls).toBe(2);

    advance(15); // refresh #2 is now overdue (slower than the TTL) ...
    resolvePending(resolvers, 1, 2); // ... and settles late
    await sleep(0);
    advance(5); // inside the fresh window measured from SETTLE
    expect(await memo('a')).toBe(2); // no extra load for the overdue refresh
    expect(calls).toBe(2);

    advance(10); // a full TTL passes after settle
    expect(await memo('a')).toBe(2); // the next SWR refresh starts
    expect(calls).toBe(3);
  });

  it('without the flag an expired entry still blocks on a reload (unchanged)', async () => {
    const c = counter((n) => n);
    const memo = ttlMemo({
      ttlMs: 10,
      keyFn: (k: string) => k,
      loader: c.loader,
      enableInTests: true,
    });
    expect(await memo('a')).toBe(1);
    await sleep(25);
    expect(await memo('a')).toBe(2); // reloaded, not served stale
    expect(c.calls).toBe(2);
  });
});
