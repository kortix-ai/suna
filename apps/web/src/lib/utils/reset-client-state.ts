import { getSharedQueryClient } from '@/lib/query-client-singleton';
import { clearUserLocalStorage } from '@/lib/utils/clear-local-storage';
import { clearSessionIDBCache } from '@/lib/idb-sync-cache';
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
 */
export async function resetClientState(): Promise<void> {
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

  clearUserLocalStorage();
  await clearSessionIDBCache();
}
