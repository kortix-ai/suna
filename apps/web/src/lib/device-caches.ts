import { getSharedQueryClient } from '@/lib/query-client-singleton';
import {
  browserKeyValueStorage,
  createPersistedQueryCache,
  createSavedCopyStore,
  isPersistableQueryKey,
  setSavedCopyStore,
  type PersistedQueryCache,
  type SavedCopyStore,
} from '@kortix/sdk';

/**
 * What this device keeps for the signed-in user between page loads: the
 * queries a user navigates by (accounts, projects, the project gate, the
 * session lists) and the saved copy of each recently opened session. A reload
 * renders the last known state and refetches it in place, instead of a
 * loading screen on every surface.
 *
 * Owned by the auth lifecycle, not by a component. `AuthProvider` adopts the
 * caches for a user BEFORE it publishes that user, so no consumer renders a
 * frame against an empty cache, and `resetClientState()` clears them on
 * sign-out and on a user switch.
 */

/** The project gate's key (`project-access-boundary.tsx`): a reload opens the project it last admitted. */
const GATE_QUERY_KEY = 'project-access-boundary';

function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  return isPersistableQueryKey(queryKey) || queryKey[0] === GATE_QUERY_KEY;
}

let adopted: {
  userId: string;
  queries: PersistedQueryCache;
  copies: SavedCopyStore;
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
    const queries = createPersistedQueryCache({
      storage,
      userId,
      shouldPersist: shouldPersistQuery,
    });
    queries.restore(client);
    // A restored entry keeps its age, so one younger than its staleTime would
    // never refetch. Each one refetches the first time something reads it.
    void client.invalidateQueries({
      predicate: (query) => shouldPersistQuery(query.queryKey),
      refetchType: 'none',
    });
    const stopPersisting = queries.persist(client);
    // Writes are coalesced over a second; a reload inside it would lose the
    // last change.
    const flush = () => void queries.flush();
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flushWhenHidden);
    const copies = createSavedCopyStore({ storage, userId });
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
  return Promise.all([current.queries.clear(), current.copies.clear()]).then(() => undefined);
}
