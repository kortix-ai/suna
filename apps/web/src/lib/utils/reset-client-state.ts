import { getSharedQueryClient } from '@/lib/query-client-singleton';
import { withTimeBudget } from '@/lib/utils/time-budget';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@kortix/sdk/idb-sync-cache';
import { useCurrentAccountStore } from '@/stores/current-account-store';

/**
 * Wipe ALL client-side state tied to the signed-in user.
 *
 * Run on logout and whenever a *different* user signs in, so the next account
 * never inherits the previous one's data. Covers, in order:
 *   1. React Query cache — every cached server response (accounts, projects,
 *      sessions, billing, …). This is the big one that was missing.
 *   2. The persisted "current account" selection (zustand + its localStorage).
 *   3. Remaining per-user localStorage (models, agents, sandbox/tab state).
 *   4. The IndexedDB session-sync cache.
 *
 * Safe to call from anywhere (no React context needed) — the QueryClient is
 * read from the module-level singleton, so AuthProvider (mounted above the
 * React Query provider) can use it too.
 *
 * **Steps 1-3 are SYNCHRONOUS and always complete. Step 4 is bounded and may
 * be outrun.** That distinction is the contract, not an implementation detail:
 * callers await this before publishing a new identity, and `clearSessionIDBCache()`
 * can hang FOREVER — `openDB()` in `packages/sdk/src/browser/cache/idb-sync-cache.ts`
 * has no `onblocked` handler, so an `indexedDB.open` needing a version upgrade
 * while a stale tab holds the old version fires neither `success` nor `error`,
 * and the promise is memoized so every later caller parks behind it. Unbounded,
 * that meant a user could not sign out AND the app could park on its loading
 * frame at sign-in, with no error shown either way.
 *
 * Outrunning step 4 is safe because it purges INERT data: nothing in Kortix
 * reads those entries any more (see that module's own header), and they are
 * keyed `user:<id>` via `buildSessionCacheKey`, so the next account cannot read
 * them even if the purge never lands. Everything that would actually leak
 * across identities is already gone by then.
 */
export async function resetClientState({
  // Injectable ONLY so the "a hung IndexedDB purge still settles" test does not
  // have to wait two real seconds. No caller passes it.
  idbTimeoutMs,
}: { idbTimeoutMs?: number } = {}): Promise<void> {
  try {
    getSharedQueryClient()?.clear();
  } catch (error) {
    console.error('Failed to clear React Query cache:', error);
  }

  try {
    useCurrentAccountStore.getState().clear();
  } catch (error) {
    console.error('Failed to clear current-account store:', error);
  }

  try {
    clearUserLocalStorage();
  } catch (error) {
    // The only unguarded call in this function, and the one that reaches
    // `localStorage` directly. Reading that accessor THROWS in a storage-blocked
    // context (Safari private mode, a partitioned iframe). `runSignOut` absorbs
    // a rejection through `withTimeBudget`, but `AuthProvider.adoptUser` awaits
    // this bare — so an unguarded throw here rejects a SIGN-IN, before
    // `setIsLoading(false)`.
    console.error('Failed to clear per-user localStorage:', error);
  }

  const purged = await withTimeBudget(clearSessionIDBCache(), idbTimeoutMs);
  if (purged.status !== 'settled') {
    console.error('[resetClientState] session IDB purge did not complete:', purged);
  }
}
