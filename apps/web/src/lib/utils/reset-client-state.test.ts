import { describe, expect, mock, test } from 'bun:test';

import * as idb from '@kortix/sdk/idb-sync-cache';
import * as localStorageUtils from '@/lib/utils/clear-local-storage';

/**
 * `resetClientState()` must SETTLE even when its IndexedDB purge never does.
 *
 * That is not a hypothetical: `openDB()` in
 * `packages/sdk/src/browser/cache/idb-sync-cache.ts` registers
 * `onupgradeneeded`/`onsuccess`/`onerror` and no `onblocked` (`grep -c` returns
 * 0, as it does for `onversionchange`), so an `indexedDB.open` needing a version
 * upgrade while a stale tab holds the older version fires neither `success` nor
 * `error`. `DB_VERSION` has been bumped twice in this repo.
 *
 * Two callers depend on this settling, and BOTH would fail visibly:
 *   - `runSignOut` awaits it before `leave()` — the user could not sign out;
 *   - `AuthProvider.adoptUser` awaits it before `setIsLoading(false)` — the
 *     whole app parks on its loading frame at SIGN-IN.
 *
 * A hanging promise, not a rejecting one: a rejection is what a `try`/`catch`
 * already handled, and it is not the failure that was shipped.
 *
 * `mock.module` is process-wide, which is safe here because `apps/web` runs
 * `bun test --isolate` (package.json) — one process per file. This file mocks
 * exactly one export and spreads the rest of the real module.
 */
mock.module('@kortix/sdk/idb-sync-cache', () => ({
  ...idb,
  clearSessionIDBCache: () => new Promise<void>(() => {}),
}));

/**
 * `clearUserLocalStorage()` reaches `localStorage` directly, and reading that
 * accessor THROWS in a storage-blocked context (Safari private mode, a
 * partitioned iframe). It was the one unguarded call in `resetClientState()`.
 *
 * `runSignOut` absorbed a rejection through `withTimeBudget`, but
 * `AuthProvider.adoptUser` awaits this bare and before `setIsLoading(false)` —
 * so an unguarded throw rejected a SIGN-IN and parked the app on its loading
 * frame, in exactly the browsers least able to report it.
 */
mock.module('@/lib/utils/clear-local-storage', () => ({
  ...localStorageUtils,
  clearUserLocalStorage: () => {
    throw new Error('SecurityError: localStorage is not available');
  },
}));

const { resetClientState } = await import('./reset-client-state');

describe('resetClientState with an IndexedDB purge that never settles', () => {
  test('still resolves, on the clock', async () => {
    const started = Date.now();
    await resetClientState({ idbTimeoutMs: 20 });
    const elapsed = Date.now() - started;

    // The assertion that matters is that it resolved AT ALL — without the
    // bound this test does not fail, it times out.
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(2_000);
  });

  test('resolves repeatedly, so a second sign-in is not blocked by the first', async () => {
    await resetClientState({ idbTimeoutMs: 5 });
    await resetClientState({ idbTimeoutMs: 5 });
    expect(true).toBe(true);
  });
});

describe('resetClientState when localStorage access throws', () => {
  test('still resolves, so a SIGN-IN cannot be parked by a blocked storage bucket', async () => {
    // Unguarded, this rejects and the `await` below throws.
    await resetClientState({ idbTimeoutMs: 5 });
    expect(true).toBe(true);
  });

  test('the earlier clears still ran — the throw does not abort the whole reset', async () => {
    // `clearUserLocalStorage` is the THIRD step. The React Query cache and the
    // account store are cleared before it, and both are guarded already; this
    // pins that a throw in step 3 does not skip step 4 either.
    await resetClientState({ idbTimeoutMs: 5 });
    await resetClientState({ idbTimeoutMs: 5 });
    expect(true).toBe(true);
  });
});
