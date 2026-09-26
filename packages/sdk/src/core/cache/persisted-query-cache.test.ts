import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import {
  createPersistedQueryCache,
  isPersistableQueryKey,
  type KeyValueStorage,
} from './persisted-query-cache';

/**
 * A reload used to start every surface from nothing: the project gate, the
 * sidebar session list and the account switcher all waited on the network,
 * so a slow backend showed a loading screen where the user's sessions had been
 * a second earlier. These tests pin the cache that survives the reload.
 */

const T0 = Date.parse('2026-09-26T12:00:00Z');
const USER = 'user-a';
const SESSIONS_KEY = ['kx', 'project', 'p1', 'sessions', 'list-paged', 'visible'] as const;
const PROJECT_KEY = ['kx', 'project', 'p1', 'detail'] as const;
const MESSAGES_KEY = ['kx', 'project', 'p1', 'sessions', 's1', 'messages'] as const;

function memoryStorage(): KeyValueStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const storage = {
    data,
    writes: 0,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.writes += 1;
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  return storage;
}

function asyncStorage(inner = memoryStorage()): KeyValueStorage & { inner: typeof inner } {
  return {
    inner,
    getItem: async (key: string) => inner.getItem(key),
    setItem: async (key: string, value: string) => inner.setItem(key, value),
    removeItem: async (key: string) => inner.removeItem(key),
  };
}

/** `getQueryData` infers `undefined` from an untagged const key; the tests read `unknown`. */
const dataOf = (client: QueryClient, key: readonly unknown[]): unknown => client.getQueryData(key);

const sessionPages = {
  pages: [{ items: [{ session_id: 's1', name: 'Fix the audit 5xx' }], next_cursor: null }],
  pageParams: [null],
};

function persistNow(storage: KeyValueStorage, client: QueryClient, userId = USER, now = T0) {
  const cache = createPersistedQueryCache({
    storage,
    userId,
    shouldPersist: isPersistableQueryKey,
    throttleMs: 0,
    now: () => now,
  });
  const stop = cache.persist(client);
  return { cache, stop };
}

describe('a reload renders the last known data, then refreshes it', () => {
  test('restores a persisted session list with its original age, so it still refetches', async () => {
    const storage = memoryStorage();
    const before = new QueryClient();
    before.setQueryData(SESSIONS_KEY, sessionPages, { updatedAt: T0 - 60_000 });
    const { cache } = persistNow(storage, before);
    await cache.flush();

    const after = new QueryClient();
    const restored = createPersistedQueryCache({
      storage,
      userId: USER,
      shouldPersist: isPersistableQueryKey,
      now: () => T0,
    }).restore(after);

    expect(restored).toBe(1);
    expect(dataOf(after, SESSIONS_KEY)).toEqual(sessionPages);
    expect(after.getQueryState(SESSIONS_KEY)?.dataUpdatedAt).toBe(T0 - 60_000);
    expect(after.getQueryState(SESSIONS_KEY)?.status).toBe('success');
  });

  test('restores synchronously from synchronous storage, so the first frame has the data', async () => {
    const storage = memoryStorage();
    const before = new QueryClient();
    before.setQueryData(PROJECT_KEY, { project_id: 'p1' }, { updatedAt: T0 });
    const { cache } = persistNow(storage, before);
    await cache.flush();

    const after = new QueryClient();
    const result = createPersistedQueryCache({
      storage,
      userId: USER,
      shouldPersist: isPersistableQueryKey,
      now: () => T0,
    }).restore(after);

    expect(typeof result).toBe('number');
    expect(dataOf(after, PROJECT_KEY)).toEqual({ project_id: 'p1' });
  });

  test('restores from asynchronous storage with a promise', async () => {
    const storage = asyncStorage();
    const before = new QueryClient();
    before.setQueryData(PROJECT_KEY, { project_id: 'p1' }, { updatedAt: T0 });
    const { cache } = persistNow(storage, before);
    await cache.flush();

    const after = new QueryClient();
    const result = createPersistedQueryCache({
      storage,
      userId: USER,
      shouldPersist: isPersistableQueryKey,
      now: () => T0,
    }).restore(after);

    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(1);
    expect(dataOf(after, PROJECT_KEY)).toEqual({ project_id: 'p1' });
  });

  test('never overwrites fresher data already in memory', async () => {
    const storage = memoryStorage();
    const before = new QueryClient();
    before.setQueryData(PROJECT_KEY, { name: 'old' }, { updatedAt: T0 - 10_000 });
    const { cache } = persistNow(storage, before);
    await cache.flush();

    const after = new QueryClient();
    after.setQueryData(PROJECT_KEY, { name: 'new' }, { updatedAt: T0 });
    createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(after);

    expect(dataOf(after, PROJECT_KEY)).toEqual({ name: 'new' });
  });
});

describe('what is kept', () => {
  test('writes only the queries the predicate accepts', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    client.setQueryData(SESSIONS_KEY, sessionPages, { updatedAt: T0 });
    client.setQueryData(MESSAGES_KEY, [{ id: 'msg_1' }], { updatedAt: T0 });
    const { cache } = persistNow(storage, client);
    await cache.flush();

    const after = new QueryClient();
    createPersistedQueryCache({ storage, userId: USER, shouldPersist: () => true, now: () => T0 }).restore(after);
    expect(dataOf(after, SESSIONS_KEY)).toEqual(sessionPages);
    expect(dataOf(after, MESSAGES_KEY)).toBeUndefined();
  });

  test('keeps the last good data of a query whose refetch failed', async () => {
    const storage = memoryStorage();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(PROJECT_KEY, { name: 'kept' }, { updatedAt: T0 });
    await client
      .fetchQuery({ queryKey: PROJECT_KEY, queryFn: () => Promise.reject(new Error('502')), staleTime: 0 })
      .catch(() => undefined);
    expect(client.getQueryState(PROJECT_KEY)?.status).toBe('error');
    const { cache } = persistNow(storage, client);
    await cache.flush();

    const after = new QueryClient();
    createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(after);
    expect(dataOf(after, PROJECT_KEY)).toEqual({ name: 'kept' });
  });

  test('drops a query the app removed from its cache', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    client.setQueryData(PROJECT_KEY, { name: 'deleted soon' }, { updatedAt: T0 });
    const { cache } = persistNow(storage, client);
    await cache.flush();
    client.removeQueries({ queryKey: PROJECT_KEY });
    await cache.flush();

    const after = new QueryClient();
    createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(after);
    expect(dataOf(after, PROJECT_KEY)).toBeUndefined();
  });

  test('keeps the newest entries when the payload is over the size cap', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    const big = 'x'.repeat(600);
    client.setQueryData(['kx', 'project', 'old', 'detail'], { big }, { updatedAt: T0 - 3_000 });
    client.setQueryData(['kx', 'project', 'mid', 'detail'], { big }, { updatedAt: T0 - 2_000 });
    client.setQueryData(['kx', 'project', 'new', 'detail'], { big }, { updatedAt: T0 - 1_000 });
    const cache = createPersistedQueryCache({
      storage,
      userId: USER,
      shouldPersist: isPersistableQueryKey,
      maxBytes: 1_500,
      throttleMs: 0,
      now: () => T0,
    });
    cache.persist(client);
    await cache.flush();

    const after = new QueryClient();
    createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(after);
    expect(dataOf(after, ['kx', 'project', 'new', 'detail'])).toEqual({ big });
    expect(dataOf(after, ['kx', 'project', 'mid', 'detail'])).toEqual({ big });
    expect(dataOf(after, ['kx', 'project', 'old', 'detail'])).toBeUndefined();
  });

  test('a full storage does not throw; it retries with a smaller payload', async () => {
    const inner = memoryStorage();
    let refusals = 0;
    const storage: KeyValueStorage = {
      getItem: inner.getItem,
      removeItem: inner.removeItem,
      setItem: (key, value) => {
        if (value.length > 900) {
          refusals += 1;
          throw new Error('QuotaExceededError');
        }
        inner.setItem(key, value);
      },
    };
    const client = new QueryClient();
    const big = 'x'.repeat(300);
    for (let i = 0; i < 4; i++) {
      client.setQueryData(['kx', 'project', `p${i}`, 'detail'], { big }, { updatedAt: T0 - (4 - i) * 1_000 });
    }
    const { cache } = persistNow(storage, client);
    await cache.flush();

    expect(refusals).toBeGreaterThan(0);
    const after = new QueryClient();
    const restored = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(after);
    expect(restored).toBeGreaterThan(0);
    expect(dataOf(after, ['kx', 'project', 'p3', 'detail'])).toEqual({ big });
  });
});

describe('whose cache, and how old', () => {
  test("never restores another user's cache", async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    client.setQueryData(PROJECT_KEY, { owner: 'a' }, { updatedAt: T0 });
    const { cache } = persistNow(storage, client, 'user-a');
    await cache.flush();

    const other = new QueryClient();
    const restored = createPersistedQueryCache({ storage, userId: 'user-b', shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(other);
    expect(restored).toBe(0);
    expect(dataOf(other, PROJECT_KEY)).toBeUndefined();
  });

  test('discards a cache written by another version', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    client.setQueryData(PROJECT_KEY, { v: 1 }, { updatedAt: T0 });
    const writer = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, version: '1', throttleMs: 0, now: () => T0 });
    writer.persist(client);
    await writer.flush();

    const after = new QueryClient();
    const reader = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, version: '2', now: () => T0 });
    expect(reader.restore(after)).toBe(0);
    expect(dataOf(after, PROJECT_KEY)).toBeUndefined();
    expect(storage.data.size).toBe(0);
  });

  test('skips entries older than the maximum age', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    client.setQueryData(PROJECT_KEY, { stale: true }, { updatedAt: T0 - 8 * 24 * 3_600_000 });
    client.setQueryData(SESSIONS_KEY, sessionPages, { updatedAt: T0 - 60_000 });
    const { cache } = persistNow(storage, client);
    await cache.flush();

    const after = new QueryClient();
    const restored = createPersistedQueryCache({
      storage,
      userId: USER,
      shouldPersist: isPersistableQueryKey,
      maxAgeMs: 7 * 24 * 3_600_000,
      now: () => T0,
    }).restore(after);
    expect(restored).toBe(1);
    expect(dataOf(after, PROJECT_KEY)).toBeUndefined();
    expect(dataOf(after, SESSIONS_KEY)).toEqual(sessionPages);
  });

  test("clear() forgets this user's cache", async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    client.setQueryData(PROJECT_KEY, { name: 'x' }, { updatedAt: T0 });
    const { cache } = persistNow(storage, client);
    await cache.flush();
    await cache.clear();

    const after = new QueryClient();
    expect(
      createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(after),
    ).toBe(0);
  });

  test('a corrupt entry is removed, not thrown', () => {
    const storage = memoryStorage();
    const cache = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 });
    storage.setItem(cache.storageKey, '{not json');
    expect(cache.restore(new QueryClient())).toBe(0);
    expect(storage.data.has(cache.storageKey)).toBe(false);
  });
});

describe('writes', () => {
  test('coalesces a burst of updates into one write', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    const cache = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, throttleMs: 50, now: () => T0 });
    cache.persist(client);
    for (let i = 0; i < 10; i++) client.setQueryData(PROJECT_KEY, { i }, { updatedAt: T0 + i });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(storage.writes).toBe(1);
  });

  test('ignores updates to queries it does not keep', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    const cache = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, throttleMs: 0, now: () => T0 });
    cache.persist(client);
    client.setQueryData(MESSAGES_KEY, [{ id: 'msg_1' }], { updatedAt: T0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.writes).toBe(0);
  });

  test('the returned stop function ends the subscription', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    const cache = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, throttleMs: 0, now: () => T0 });
    const stop = cache.persist(client);
    stop();
    client.setQueryData(PROJECT_KEY, { name: 'x' }, { updatedAt: T0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.writes).toBe(0);
  });
});

describe('isPersistableQueryKey', () => {
  test.each([
    [['kx', 'accounts', 'user-a']],
    [['kx', 'projects', 'acct-1']],
    [['kx', 'projects', 'all']],
    [['kx', 'project', 'p1', 'summary']],
    [['kx', 'project', 'p1', 'detail']],
    [['kx', 'project', 'p1', 'sessions', 'list-paged', 'visible']],
    [['kx', 'project', 'p1', 'sessions', 'list-paged', 'project']],
    [['kx', 'project', 'p1', 'sessions', 's1']],
  ])('keeps %j', (key) => {
    expect(isPersistableQueryKey(key)).toBe(true);
  });

  test.each([
    [['kx', 'accounts', 'anonymous']],
    [['kx', 'accounts', 'my-invites', 'user-a']],
    [['kx', 'project', 'p1', 'sessions', 's1', 'messages']],
    [['kx', 'project', 'p1', 'sessions', 's1', 'turn']],
    [['kx', 'project', 'p1', 'sessions', 's1', 'prompts']],
    [['kx', 'project', 'p1', 'sessions', 'list', 'visible']],
    [['kx', 'project', 'p1', 'secrets']],
    [['kx', 'project', 'p1', 'files']],
    [['kx', 'project', 'p1', 'config']],
    [['project-access-boundary', 'p1', 'user-a']],
    [[]],
  ])('does not keep %j', (key) => {
    expect(isPersistableQueryKey(key)).toBe(false);
  });
});

describe('a restored entry refetches once', () => {
  test('restored entries are invalidated, so one younger than its staleTime still refetches', async () => {
    const storage = memoryStorage();
    const before = new QueryClient();
    before.setQueryData(PROJECT_KEY, { name: 'x' }, { updatedAt: T0 - 1_000 });
    const { cache } = persistNow(storage, before);
    await cache.flush();

    const after = new QueryClient();
    createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, now: () => T0 }).restore(
      after,
    );

    expect(after.getQueryState(PROJECT_KEY)?.isInvalidated).toBe(true);
    // Only what was restored: an entry the client already had is left as it is.
    const other = ['kx', 'project', 'p2', 'detail'] as const;
    after.setQueryData(other, { name: 'fresh' });
    expect(after.getQueryState(other)?.isInvalidated).toBe(false);
  });
});

describe('flush', () => {
  test('writes nothing when nothing changed since the last write', async () => {
    const storage = memoryStorage();
    const client = new QueryClient();
    client.setQueryData(PROJECT_KEY, { name: 'x' }, { updatedAt: T0 });
    const cache = createPersistedQueryCache({ storage, userId: USER, shouldPersist: isPersistableQueryKey, throttleMs: 50, now: () => T0 });
    cache.persist(client);

    await cache.flush();
    await cache.flush();
    expect(storage.writes).toBe(1);

    client.setQueryData(PROJECT_KEY, { name: 'y' }, { updatedAt: T0 + 1 });
    await cache.flush();
    expect(storage.writes).toBe(2);
  });
});
