import { afterEach, describe, expect, test } from 'bun:test';

import type { SessionTranscriptSyncEnvelope } from '../../core/rest/projects-client/sessions';
import { createSavedCopyStore, setSavedCopyStore } from '../../core/session-sync/saved-copy-store';
import {
  clearSessionIDBCache,
  deleteSessionFromIDB,
  indexedDBKeyValueStorage,
  loadAllSessionIdsFromIDB,
  loadSessionFromIDB,
  saveSessionToIDB,
} from './idb-sync-cache';

/**
 * The web keeps each session's saved copy in IndexedDB, not localStorage:
 * reading it no longer parses up to 300 KB synchronously before the first
 * frame, and it no longer shares the origin's ~5 MB localStorage bucket with
 * drafts and preferences. The database is the one the retired transcript
 * mirror used (`kortix-session-cache`); version 4 drops that mirror's rows.
 */

type Stores = Map<string, Map<string, unknown>>;

/** The slice of IndexedDB the module uses, in memory. Every callback fires on a later task, as in a browser. */
function fakeIndexedDB(
  options: {
    blocked?: boolean;
    version?: number;
    stores?: string[];
    upgradeThrows?: boolean;
    resultMissing?: boolean;
  } = {},
) {
  const databases = new Map<string, { version: number; stores: Stores }>();
  if (options.version) {
    databases.set('kortix-session-cache', {
      version: options.version,
      stores: new Map((options.stores ?? []).map((name) => [name, new Map([['old', 'row']])])),
    });
  }
  const later = (fn: () => void) => setTimeout(fn, 0);
  const factory = {
    open(name: string, version: number) {
      const request: Record<string, any> = {};
      let aborted = false;
      later(() => {
        if (options.blocked) {
          request.onblocked?.();
          return;
        }
        let db = databases.get(name);
        const previous = db?.version ?? 0;
        if (!db) {
          db = { version, stores: new Map() };
          databases.set(name, db);
        }
        const stores = db.stores;
        const database = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string) => {
            // Chrome 115 in the field: the upgrade transaction is gone by the
            // time the handler runs.
            if (options.upgradeThrows) {
              throw new Error(
                "InvalidStateError: Failed to execute 'createObjectStore' on 'IDBDatabase': The database is not running a version change transaction.",
              );
            }
            stores.set(store, new Map());
          },
          deleteObjectStore: (store: string) => void stores.delete(store),
          close() {},
          transaction(store: string) {
            const rows = stores.get(store);
            if (!rows) throw new Error(`NotFoundError: ${store}`);
            const tx: Record<string, any> = {};
            const step = <T>(fn: () => T) => {
              const req: Record<string, any> = {};
              later(() => {
                req.result = fn();
                later(() => tx.oncomplete?.());
              });
              return req;
            };
            tx.objectStore = () => ({
              get: (key: string) => step(() => rows.get(key)),
              put: (value: unknown, key: string) => step(() => void rows.set(key, value)),
              delete: (key: string) => step(() => void rows.delete(key)),
              clear: () => step(() => rows.clear()),
            });
            return tx;
          },
        };
        // iOS 18.7 Safari in the field: `request.result` is still undefined
        // when `onupgradeneeded` fires, and reading `result.objectStoreNames`
        // inside the handler raised `TypeError: undefined is not an object`.
        if (!options.resultMissing) request.result = database;
        if (version > previous) {
          // During the upgrade the connection carries its version-change
          // transaction; the version change commits only when the upgrade
          // completes, so an aborted upgrade leaves the previous version.
          request.transaction = {
            abort: () => {
              aborted = true;
            },
          };
          request.onupgradeneeded?.();
          request.transaction = null;
          db.version = aborted ? previous : version;
        }
        // The result exists by completion; only the upgrade handler saw none.
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory, databases };
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
function install(factory: unknown) {
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true });
}
afterEach(() => {
  setSavedCopyStore(null);
  if (original) Object.defineProperty(globalThis, 'indexedDB', original);
  else delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

function envelope(): SessionTranscriptSyncEnvelope {
  return {
    available: true,
    reason: null,
    source: 'mirror',
    complete: true,
    captured_at: '2026-10-06T00:00:00.000Z',
    opencode_session_id: 'ses_root',
    message_count: 1,
    messages: [
      {
        info: { id: 'msg_1', role: 'user', sessionID: 'ses_root', time: { created: 1 } },
        parts: [{ id: 'prt_1', type: 'text', text: 'hello' }],
      },
    ],
  } as unknown as SessionTranscriptSyncEnvelope;
}

describe('indexedDBKeyValueStorage', () => {
  test('is null where there is no IndexedDB', () => {
    install(undefined);
    expect(indexedDBKeyValueStorage()).toBeNull();
  });

  test('reads back what it wrote, asynchronously, and forgets a removed key', async () => {
    install(fakeIndexedDB().factory);
    const storage = indexedDBKeyValueStorage()!;
    const pending = storage.getItem('a');
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBeNull();

    await storage.setItem('a', 'one');
    await storage.setItem('b', 'two');
    expect(await storage.getItem('a')).toBe('one');
    expect(await storage.getItem('b')).toBe('two');

    await storage.removeItem('a');
    expect(await storage.getItem('a')).toBeNull();
    expect(await storage.getItem('b')).toBe('two');
  });

  test("the upgrade drops the retired mirror's rows", async () => {
    const fake = fakeIndexedDB({ version: 3, stores: ['sessions'] });
    install(fake.factory);
    await indexedDBKeyValueStorage()!.setItem('k', 'v');
    const db = fake.databases.get('kortix-session-cache')!;
    expect(db.version).toBe(4);
    expect([...db.stores.keys()]).toEqual(['saved-copies']);
  });

  test('a blocked upgrade reads as an empty store instead of hanging', async () => {
    install(fakeIndexedDB({ blocked: true }).factory);
    const storage = indexedDBKeyValueStorage()!;
    expect(await storage.getItem('k')).toBeNull();
    await expect(Promise.resolve(storage.setItem('k', 'v'))).rejects.toThrow();
  });

  test('an upgrade that throws fails the open instead of escaping to window.onerror', async () => {
    // Better Stack (Kortix Frontend prod): `InvalidStateError: Failed to execute
    // 'createObjectStore' on 'IDBDatabase'` thrown inside `onupgradeneeded`,
    // uncaught, reported through the global error handler.
    install(fakeIndexedDB({ upgradeThrows: true }).factory);
    const storage = indexedDBKeyValueStorage()!;
    expect(await storage.getItem('k')).toBeNull();
    await expect(Promise.resolve(storage.setItem('k', 'v'))).rejects.toThrow('createObjectStore');
  });

  test('an upgrade that finds no database fails the open instead of escaping to window.onerror', async () => {
    // Better Stack (Kortix Frontend prod, 2026-10-16, iOS 18.7 Safari):
    // `TypeError: undefined is not an object (evaluating 'e.objectStoreNames')`
    // thrown inside `onupgradeneeded` when `request.result` was still undefined.
    install(fakeIndexedDB({ resultMissing: true }).factory);
    const storage = indexedDBKeyValueStorage();
    if (!storage) throw new Error('IndexedDB storage unavailable');
    expect(await storage.getItem('k')).toBeNull();
    await expect(Promise.resolve(storage.setItem('k', 'v'))).rejects.toThrow(TypeError);
  });

  test('backs a saved-copy store end to end', async () => {
    install(fakeIndexedDB().factory);
    const copies = createSavedCopyStore({ storage: indexedDBKeyValueStorage()!, userId: 'user-a' });
    await copies.write('p1', 's1', envelope());
    const read = await copies.read('p1', 's1');
    expect(read?.messages).toHaveLength(1);
  });
});

describe('the deprecated mirror API', () => {
  test('clearSessionIDBCache forgets every saved copy on the device', async () => {
    install(fakeIndexedDB().factory);
    const storage = indexedDBKeyValueStorage()!;
    const copies = createSavedCopyStore({ storage, userId: 'user-a' });
    await copies.write('p1', 's1', envelope());

    await clearSessionIDBCache();

    expect(await copies.read('p1', 's1')).toBeNull();
    expect(await storage.getItem('kortix.saved-copy:user-a:index')).toBeNull();
  });

  test("deleteSessionFromIDB with a Kortix session scope drops that session's saved copy", async () => {
    install(fakeIndexedDB().factory);
    const copies = createSavedCopyStore({ storage: indexedDBKeyValueStorage()!, userId: 'user-a' });
    setSavedCopyStore(copies);
    await copies.write('p1', 's1', envelope());
    await copies.write('p1', 's2', envelope());

    await deleteSessionFromIDB('ses_root', 'p1/s1');

    expect(await copies.read('p1', 's1')).toBeNull();
    expect(await copies.read('p1', 's2')).not.toBeNull();
  });

  test('the read/write half keeps its signatures and stores nothing', async () => {
    install(fakeIndexedDB().factory);
    await saveSessionToIDB('ses_1', [{ id: 'msg_1' }], {});
    expect(await loadSessionFromIDB('ses_1')).toBeNull();
    expect(await loadAllSessionIdsFromIDB()).toEqual([]);
  });
});
