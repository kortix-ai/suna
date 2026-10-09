/**
 * IndexedDB on the web: where the device keeps each session's saved copy.
 *
 * `indexedDBKeyValueStorage()` is the `KeyValueStorage` the web host hands to
 * `createSavedCopyStore`. It replaced `localStorage` for the saved copies for
 * two reasons: a localStorage read is synchronous, so opening a session parsed
 * up to 300 KB of JSON before the first frame; and localStorage is one ~5 MB
 * bucket per origin, shared with drafts and preferences, which 1.5 MB of
 * copies crowded out. An IndexedDB read is asynchronous, and its quota is the
 * disk's.
 *
 * The database is `kortix-session-cache`, the one the retired transcript
 * mirror used. That mirror is GONE: its freshness test read the transcript's
 * SHAPE, so a stopped turn painted as running (`no-transcript-mirror.test.ts`
 * keeps it out of the live path). Version 4 drops its `sessions` rows and
 * creates `saved-copies`, a plain key-value store of the saved-copy store's
 * strings. Every function the mirror published stays, deprecated:
 *
 *  - `clearSessionIDBCache` empties `saved-copies` (sign-out, user switch);
 *  - `deleteSessionFromIDB` drops one session's saved copy when given its
 *    Kortix session scope;
 *  - `saveSessionToIDB` / `loadSessionFromIDB` / `flushIDBWrites` /
 *    `loadAllSessionIdsFromIDB` / `pruneIDBCache` keep their signatures and
 *    store nothing.
 */

import type { KeyValueStorage } from '../../core/cache/persisted-query-cache';
import { currentSavedCopyStore } from '../../core/session-sync/saved-copy-store';
import { parseKortixSessionScope } from '../session-sync/server-transcript-mirror';

const DB_NAME = 'kortix-session-cache';
/** 4 — drops the retired mirror's `sessions` store and creates `saved-copies`. */
const DB_VERSION = 4;
const STORE_NAME = 'saved-copies';
const RETIRED_STORE_NAME = 'sessions';

/** One open connection per factory: a test installs a fresh one per case. */
const connections = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

function factory(): IDBFactory | undefined {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  } catch {
    // Reading the property throws where storage is blocked.
    return undefined;
  }
}

function openDB(): Promise<IDBDatabase> {
  const idb = factory();
  if (!idb) return Promise.reject(new Error('IndexedDB not available'));
  const open = connections.get(idb);
  if (open) return open;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(RETIRED_STORE_NAME)) db.deleteObjectStore(RETIRED_STORE_NAME);
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer build's upgrade in another tab must not wait on this one.
      db.onversionchange = () => {
        db.close();
        connections.delete(idb);
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    // Another tab holds an older version open. Without this the open waits
    // until that tab closes, and every read parks behind it.
    request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
  connections.set(idb, pending);
  pending.catch(() => connections.delete(idb));
  return pending;
}

function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = operation(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/**
 * IndexedDB as an asynchronous {@link KeyValueStorage}, or `null` where there
 * is none (server render, React Native). A read that fails resolves `null`; a
 * write that fails (quota, blocked upgrade) rejects, so the caller can evict
 * and retry.
 */
export function indexedDBKeyValueStorage(): KeyValueStorage | null {
  if (!factory()) return null;
  return {
    getItem: (key) =>
      run('readonly', (store) => store.get(key)).then(
        (value) => (typeof value === 'string' ? value : null),
        () => null,
      ),
    setItem: (key, value) => run('readwrite', (store) => store.put(value, key)).then(() => undefined),
    removeItem: (key) => run('readwrite', (store) => store.delete(key)).then(() => undefined),
  };
}

/** @deprecated The transcript mirror is retired. Stores nothing. Removed in the next major. */
export async function saveSessionToIDB(
  _sessionId: string,
  _messages: any[],
  _parts: Record<string, any[]>,
  _kortixSessionScope?: string,
): Promise<void> {}

/** @deprecated The transcript mirror is retired. Removed in the next major. */
export function flushIDBWrites(): Promise<void> {
  return Promise.resolve();
}

/** @deprecated The transcript mirror is retired. Always `null`. Removed in the next major. */
export async function loadSessionFromIDB(
  _sessionId: string,
  _kortixSessionScope?: string,
): Promise<{ messages: any[]; parts: Record<string, any[]> } | null> {
  return null;
}

/** @deprecated The transcript mirror is retired. Always empty. Removed in the next major. */
export async function loadAllSessionIdsFromIDB(): Promise<string[]> {
  return [];
}

/**
 * @deprecated Delete the session with `deleteProjectSession`, which drops its
 * saved copy. This drops the saved copy of the Kortix session `kortixSessionScope`
 * (`<projectId>/<sessionId>`); without a scope it does nothing.
 */
export async function deleteSessionFromIDB(_sessionId: string, kortixSessionScope?: string): Promise<void> {
  const scope = parseKortixSessionScope(kortixSessionScope);
  if (!scope) return;
  await currentSavedCopyStore()?.remove(scope.projectId, scope.sessionId);
}

/**
 * @deprecated Kept for its callers. Forgets every saved copy on this device;
 * the host calls it on sign-out and on a user switch.
 */
export async function clearSessionIDBCache(): Promise<void> {
  try {
    await run('readwrite', (store) => store.clear());
  } catch {
    // Nothing kept, or nothing reachable.
  }
}

/** @deprecated The saved-copy store bounds itself. Does nothing. Removed in the next major. */
export async function pruneIDBCache(): Promise<void> {}
