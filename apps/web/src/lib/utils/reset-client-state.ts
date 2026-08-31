import { getSharedQueryClient } from '@/lib/query-client-singleton';
import { withTimeBudget } from '@/lib/utils/time-budget';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@kortix/sdk/idb-sync-cache';
import { clearImpersonationSession } from '@kortix/sdk';
import { useCurrentAccountStore } from '@/stores/current-account-store';
import { clearAutoProjectSuppression } from '@/lib/onboarding/ensure-first-project';
import { resetAllRegisteredPersistedStores } from '@/stores/persisted-store-registry';

/**
 * Wipe ALL client-side state tied to the signed-in user.
 *
 * Run on logout and whenever a *different* user signs in, so the next account
 * never inherits the previous one's data. Covers, in order:
 *   1. React Query cache — every cached server response (accounts, projects,
 *      sessions, billing, …). This is the big one that was missing.
 *   2. The persisted "current account" selection (zustand + its localStorage).
 *   3. Every OTHER persisted zustand store's IN-MEMORY state — via
 *      `resetAllRegisteredPersistedStores()`, see `persisted-store-registry.ts`
 *      — plus the SDK's impersonation session, which lives partly at module
 *      scope (`current`/`hydrated` in
 *      `packages/sdk/src/core/http/impersonation.ts`) and so cannot be forgotten
 *      by deleting its sessionStorage key alone.
 *   4. Remaining per-user localStorage AND sessionStorage — a PREFIX sweep,
 *      not a delete-list; see `clear-local-storage.ts`. Runs AFTER step 3 so a
 *      store that just had its in-memory state reset has nothing left to
 *      re-persist.
 *   5. The IndexedDB session-sync cache.
 *
 * Safe to call from anywhere (no React context needed) — the QueryClient is
 * read from the module-level singleton, so AuthProvider (mounted above the
 * React Query provider) can use it too.
 *
 * **Steps 1-4 are SYNCHRONOUS and always complete. Step 5 is bounded and may
 * be outrun.** That distinction is the contract, not an implementation detail:
 * callers await this before publishing a new identity, and `clearSessionIDBCache()`
 * can hang FOREVER — `openDB()` in `packages/sdk/src/browser/cache/idb-sync-cache.ts`
 * has no `onblocked` handler, so an `indexedDB.open` needing a version upgrade
 * while a stale tab holds the old version fires neither `success` nor `error`,
 * and the promise is memoized so every later caller parks behind it. Unbounded,
 * that meant a user could not sign out AND the app could park on its loading
 * frame at sign-in, with no error shown either way.
 *
 * Outrunning step 5 is safe because it purges INERT data: nothing in Kortix
 * reads those entries any more (see that module's own header), and they are
 * keyed `user:<id>` via `buildSessionCacheKey`, so the next account cannot read
 * them even if the purge never lands. Everything that would actually leak
 * across identities is already gone by then.
 *
 * Does NOT clear `kortix_last_project`. That cookie is owner-bound
 * (`<userId>:<projectId>`) and deliberately survives sign-out — the
 * middleware reads its owner half to attribute a post-logout bounce. See
 * `lib/onboarding/last-project-cookie.ts` and the tripwire test at
 * `lib/auth/sign-out-navigation.test.ts`.
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

  // Does NOT statically import the stores it resets. Each persisted store
  // registers its own reset at its OWN module scope (see
  // `persisted-store-registry.ts`) so that `reset-client-state.ts` — reachable
  // from every route through `AuthProvider` — cannot drag a feature-heavy
  // store's transitive imports (e.g. `session-browser-store.ts` →
  // `kortix-computer-store.ts` → the shiki-backed markdown renderer) into
  // every route's initial JS chunk. `connectors-page.chunk.test.ts` is the
  // regression this avoids; it was tripped once already during this change.
  resetAllRegisteredPersistedStores();

  try {
    clearImpersonationSession();
  } catch (error) {
    console.error('Failed to clear impersonation session:', error);
  }

  try {
    clearAutoProjectSuppression();
  } catch (error) {
    console.error('Failed to clear auto-project suppression:', error);
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
