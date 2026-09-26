import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { KeyValueStorage } from '@kortix/sdk';

import { applyPersistedQueryDefaults, isPersistedQueryKey } from './persisted-queries';
import { createQueryCacheBinder } from './query-cache-binder';

/**
 * A cold start used to open every list empty and wait on the network. These
 * tests pin the binder that keeps each user's lists across a restart, and
 * never lets one user's lists reach another user.
 */

const T0 = Date.parse('2026-09-26T12:00:00Z');
const SESSIONS = ['project-sessions', 'p-1', 'paged'] as const;
const PROJECT = ['project', 'p-1'] as const;
const PAGES = {
  pages: [{ items: [{ session_id: 's-1' }], next_cursor: null }],
  pageParams: [null],
};

/** AsyncStorage's shape: every call answers with a promise. */
function asyncStorage() {
  const data = new Map<string, string>();
  const calls = { getItem: 0, setItem: 0 };
  const storage: KeyValueStorage = {
    getItem: async (key) => {
      calls.getItem += 1;
      return data.get(key) ?? null;
    },
    setItem: async (key, value) => {
      calls.setItem += 1;
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
  return { storage, data, calls };
}

function binderOver(storage: KeyValueStorage) {
  return createQueryCacheBinder({
    storage,
    shouldPersist: isPersistedQueryKey,
    throttleMs: 0,
    now: () => T0,
  });
}

const clients: QueryClient[] = [];
function newClient() {
  const client = new QueryClient();
  applyPersistedQueryDefaults(client);
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

const dataOf = (client: QueryClient, key: readonly unknown[]): unknown => client.getQueryData(key);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** One app run for `userId` that stores `write`'s queries, then ends. */
async function previousRun(
  storage: KeyValueStorage,
  userId: string,
  write: (client: QueryClient) => void
) {
  const binder = binderOver(storage);
  const client = newClient();
  await binder.bind(client, userId);
  write(client);
  await binder.flush();
}

describe('a cold start renders the last known lists', () => {
  test('bind restores the user’s stored lists, with their original age so they refetch', async () => {
    const { storage } = asyncStorage();
    await previousRun(storage, 'user-a', (client) => {
      client.setQueryData(SESSIONS, PAGES, { updatedAt: T0 - 60_000 });
      client.setQueryData(PROJECT, { project_id: 'p-1' }, { updatedAt: T0 - 60_000 });
    });

    const client = newClient();
    await binderOver(storage).bind(client, 'user-a');

    expect(dataOf(client, SESSIONS)).toEqual(PAGES);
    expect(dataOf(client, PROJECT)).toEqual({ project_id: 'p-1' });
    expect(client.getQueryState(SESSIONS)?.dataUpdatedAt).toBe(T0 - 60_000);
  });

  test('the start screen and the layout share one restore per user', async () => {
    const { storage, calls } = asyncStorage();
    const binder = binderOver(storage);
    const client = newClient();

    const first = binder.bind(client, 'user-a');
    const second = binder.bind(client, 'user-a');
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(calls.getItem).toBe(1);
    expect(binder.userId).toBe('user-a');
  });

  test('only kept queries are written: never a transcript, a secret or the file listing', async () => {
    const { storage } = asyncStorage();
    await previousRun(storage, 'user-a', (client) => {
      client.setQueryData(SESSIONS, PAGES, { updatedAt: T0 });
      client.setQueryData(['project-secrets', 'p-1'], [{ name: 'API_KEY' }], { updatedAt: T0 });
      client.setQueryData(
        ['project-detail', 'p-1'],
        { files: [{ path: 'a.ts' }] },
        { updatedAt: T0 }
      );
    });

    const client = newClient();
    await binderOver(storage).bind(client, 'user-a');

    expect(dataOf(client, SESSIONS)).toEqual(PAGES);
    expect(dataOf(client, ['project-secrets', 'p-1'])).toBeUndefined();
    expect(dataOf(client, ['project-detail', 'p-1'])).toBeUndefined();
  });

  test('a flush before the restore finished writes nothing over the stored cache', async () => {
    const { storage, data } = asyncStorage();
    await previousRun(storage, 'user-a', (client) =>
      client.setQueryData(PROJECT, { project_id: 'p-1' }, { updatedAt: T0 })
    );
    const stored = [...data.values()];

    const binder = binderOver(storage);
    const ready = binder.bind(newClient(), 'user-a');
    await binder.flush();
    expect([...data.values()]).toEqual(stored);
    await ready;
  });
});

describe('one user’s lists never reach another user', () => {
  test('a new user: the previous user’s store is forgotten and their queries leave memory first', async () => {
    const { storage, data } = asyncStorage();
    await previousRun(storage, 'user-b', (client) =>
      client.setQueryData(PROJECT, { owner: 'b' }, { updatedAt: T0 })
    );

    const binder = binderOver(storage);
    const client = newClient();
    await binder.bind(client, 'user-a');
    client.setQueryData(['accounts'], [{ account_id: 'acc-a' }], { updatedAt: T0 });
    client.setQueryData(PROJECT, { owner: 'a' }, { updatedAt: T0 - 1 });
    await binder.flush();
    expect([...data.keys()].some((key) => key.endsWith(':user-a'))).toBe(true);

    await binder.bind(client, 'user-b');

    // User A's accounts are gone from memory, user B's project is restored.
    expect(dataOf(client, ['accounts'])).toBeUndefined();
    expect(dataOf(client, PROJECT)).toEqual({ owner: 'b' });
    // User A's store is forgotten.
    expect([...data.keys()].some((key) => key.endsWith(':user-a'))).toBe(false);
    expect(binder.userId).toBe('user-b');
  });

  test('the same user signing in again keeps the queries in memory', async () => {
    const { storage } = asyncStorage();
    const binder = binderOver(storage);
    const client = newClient();
    await binder.bind(client, 'user-a');
    await binder.release();
    client.setQueryData(PROJECT, { owner: 'a' }, { updatedAt: T0 });

    await binder.bind(client, 'user-a');

    expect(dataOf(client, PROJECT)).toEqual({ owner: 'a' });
  });

  test('signed out (bind null): the store is forgotten and later updates write nothing', async () => {
    const { storage, data, calls } = asyncStorage();
    const binder = binderOver(storage);
    const client = newClient();
    await binder.bind(client, 'user-a');
    client.setQueryData(PROJECT, { owner: 'a' }, { updatedAt: T0 });
    await binder.flush();
    expect(data.size).toBe(1);

    await binder.bind(client, null);
    const writes = calls.setItem;
    client.setQueryData(PROJECT, { owner: 'a', later: true }, { updatedAt: T0 + 1 });
    await tick();

    expect(data.size).toBe(0);
    expect(calls.setItem).toBe(writes);
    expect(binder.userId).toBeNull();
  });

  test('sign-out releases before the client is cleared: no empty cache is written back', async () => {
    const { storage, data, calls } = asyncStorage();
    const binder = binderOver(storage);
    const client = newClient();
    await binder.bind(client, 'user-a');
    client.setQueryData(PROJECT, { owner: 'a' }, { updatedAt: T0 });
    await binder.flush();

    await binder.release();
    const writes = calls.setItem;
    client.clear();
    await tick();

    expect(data.size).toBe(0);
    expect(calls.setItem).toBe(writes);
  });

  test('a release while the store is still being read never starts the writes', async () => {
    const { storage, data } = asyncStorage();
    const binder = binderOver(storage);
    const client = newClient();

    const ready = binder.bind(client, 'user-a');
    await binder.release();
    await ready;
    client.setQueryData(PROJECT, { owner: 'a' }, { updatedAt: T0 });
    await tick();

    expect(data.size).toBe(0);
  });
});
