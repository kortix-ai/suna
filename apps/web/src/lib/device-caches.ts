import { getSharedQueryClient } from '@/lib/query-client-singleton';
import { registerDisposableFamily } from '@/lib/storage/managed-storage';
import {
  browserKeyValueStorage,
  createPersistedQueryCache,
  createSavedCopyStore,
  isPersistableQueryKey,
  setSavedCopyStore,
  type PersistedQueryCache,
  type SavedCopyStore,
} from '@kortix/sdk';
// A sanctioned reach into an SDK internal module: IndexedDB is browser-only,
// so the isomorphic root cannot export it. See CANONICAL_SDK_ENTRIES in
// scripts/sdk-boundary.mjs.
import { indexedDBKeyValueStorage } from '@kortix/sdk/internal/idb-sync-cache'; // eslint-disable-line no-restricted-imports

/**
 * What this device keeps for the signed-in user between page loads. Exactly
 * two device caches hold session state on the web:
 *
 *  1. IndexedDB (`kortix-session-cache` → `saved-copies`): the saved copy of
 *     each recently opened session, keyed `kortix.saved-copy:<userId>:…`. The
 *     read is asynchronous, so opening a session never parses a transcript
 *     before the first frame; the copy paints one task later.
 *  2. One localStorage entry, `kortix.query-cache:<userId>`: the queries a
 *     user navigates by (accounts, projects, the project gate, the session
 *     lists), at most {@link WEB_QUERY_CACHE_MAX_BYTES}, newest first. It is
 *     read synchronously at sign-in, so the first frame has them.
 *
 * A reload renders the last known state and refetches it in place, instead of
 * a loading screen on every surface. Nothing else holds session state: the
 * sessionStorage stream cache and the `kortix_cache_*` runtime list caches
 * are retired, and {@link sweepRetiredDeviceCaches} frees what they left.
 *
 * Owned by the auth lifecycle, not by a component. `AuthProvider` adopts the
 * caches for a user BEFORE it publishes that user, so no consumer renders a
 * frame against an empty cache, and `resetClientState()` clears them on
 * sign-out and on a user switch.
 */

/** The project gate's key (`project-access-boundary.tsx`): a reload opens the project it last admitted. */
const GATE_QUERY_KEY = 'project-access-boundary';

/**
 * The query cache's bound, in UTF-16 code units. It is read and parsed
 * synchronously at sign-in, so it stays small: a full 50-row session page
 * is ~60,000 code units, so this holds the three newest plus the project rows.
 * Over the bound, the oldest entries are dropped first.
 */
export const WEB_QUERY_CACHE_MAX_BYTES = 200_000;

const QUERY_CACHE_NAMESPACE = 'kortix.query-cache';

function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  return isPersistableQueryKey(queryKey) || queryKey[0] === GATE_QUERY_KEY;
}

let adopted: {
  userId: string;
  queries: PersistedQueryCache;
  copies: SavedCopyStore | null;
  detach: () => void;
} | null = null;

/** Restore `userId`'s caches into the shared query client and keep them current. */
export function adoptDeviceCaches(userId: string): void {
  if (adopted?.userId === userId) return;
  // Never two users at once: the previous persister would write this user's
  // queries under its own key.
  if (adopted) void clearDeviceCaches();
  const storage = browserKeyValueStorage();
  const client = getSharedQueryClient();
  if (!storage || !client) return;
  try {
    // A draft or a preference that does not fit evicts this cache first: it
    // refetches, the draft would be lost.
    registerDisposableFamily(QUERY_CACHE_NAMESPACE);
    const queries = createPersistedQueryCache({
      storage,
      userId,
      shouldPersist: shouldPersistQuery,
      maxBytes: WEB_QUERY_CACHE_MAX_BYTES,
      namespace: QUERY_CACHE_NAMESPACE,
    });
    // The SDK marks each restored entry invalidated: it refetches the first
    // time something reads it, even when younger than its staleTime.
    queries.restore(client);
    const stopPersisting = queries.persist(client);
    // Writes are coalesced over a second; a reload inside it would lose the
    // last change.
    const flush = () => void queries.flush();
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    // No IndexedDB (a blocked or partitioned context): sessions open from the
    // server's copy, as before the device kept one.
    const indexed = indexedDBKeyValueStorage();
    const copies = indexed ? createSavedCopyStore({ storage: indexed, userId }) : null;
    setSavedCopyStore(copies);
    adopted = {
      userId,
      queries,
      copies,
      detach: () => {
        stopPersisting();
        window.removeEventListener('pagehide', flush);
        document.removeEventListener('visibilitychange', flushWhenHidden);
      },
    };
  } catch (error) {
    // An accelerator only: without it the app loads as before. A throw here
    // would fail the sign-in.
    console.error('[device-caches] Failed to adopt the device caches:', error);
  }
}

/**
 * Stop writing, then forget, the adopted user's caches. The stop is
 * synchronous: once this returns, nothing can write the next user's data under
 * this user's keys. The returned promise settles when the stores are empty.
 */
export function clearDeviceCaches(): Promise<void> {
  const current = adopted;
  adopted = null;
  if (!current) return Promise.resolve();
  current.detach();
  // Unregistered before the clear, not after: the store serializes its work,
  // so the clear also removes a copy written while it was queued, and no
  // write can start after it.
  setSavedCopyStore(null);
  return Promise.all([current.queries.clear(), current.copies?.clear()]).then(() => undefined);
}

/** Key prefixes of the retired session caches: the runtime lists and the localStorage saved copies. */
const RETIRED_LOCAL_PREFIXES = [
  'kortix_cache_sessions:',
  'kortix_cache_agents:',
  'kortix_cache_commands:',
  'kortix_cache_providers:',
  'kortix.saved-copy:',
];
/** The retired sessionStorage stream cache. */
const RETIRED_SESSION_PREFIXES = ['opencode_stream_cache:'];

function sweep(name: 'localStorage' | 'sessionStorage', prefixes: readonly string[]): void {
  try {
    const storage = globalThis[name];
    if (!storage) return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Blocked storage holds nothing to free.
  }
}

/**
 * Free what the retired session caches left on this device: up to 1.5 MB of
 * localStorage saved copies and the `kortix_cache_*` runtime lists. Run once
 * per page load; nothing writes these keys any more, so a second run finds
 * nothing.
 */
export function sweepRetiredDeviceCaches(): void {
  sweep('localStorage', RETIRED_LOCAL_PREFIXES);
  sweep('sessionStorage', RETIRED_SESSION_PREFIXES);
}
