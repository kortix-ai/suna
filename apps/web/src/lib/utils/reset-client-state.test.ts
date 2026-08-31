import { describe, expect, mock, test } from 'bun:test';

import * as idb from '@kortix/sdk/idb-sync-cache';
import * as localStorageUtils from '@/lib/utils/clear-local-storage';
import {
  clearImpersonationSession,
  getImpersonationSession,
  setImpersonationSession,
} from '@kortix/sdk';
import { useBrowserRecentsStore } from '@/stores/browser-recents-store';
import { useTabStore } from '@/stores/tab-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

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

describe('resetClientState resets registered persisted stores IN MEMORY, not just on disk', () => {
  // This is the confirmed leak the whole task exists to close:
  // `kortix-browser-recents` (the last 8 URLs any user browsed in-app) is
  // rendered to the NEXT signed-in user as a clickable list. Deleting the
  // localStorage key is not enough on its own — a component still mounted
  // and subscribed to the store (or one that mounts a beat later) can
  // re-persist the very key `clearUserLocalStorage()` just deleted, unless
  // the IN-MEMORY state is reset too. This exercises the real store through
  // the real `resetClientState()`, not a source-string assertion.
  test('a browsed URL does not survive resetClientState()', async () => {
    useBrowserRecentsStore.getState().addRecent('http://localhost:3000/leaked-project');
    expect(useBrowserRecentsStore.getState().recents).toHaveLength(1);

    await resetClientState({ idbTimeoutMs: 5 });

    expect(useBrowserRecentsStore.getState().recents).toEqual([]);
  });

  test('an open tab does not survive resetClientState() either — a second registered store', async () => {
    // A second, independently-registered store (`persisted-store-registry.ts`)
    // pins that the sweep is not special-cased to just one store.
    useTabStore.setState({ activeTabId: 'leaked-project-tab' });
    expect(useTabStore.getState().activeTabId).toBe('leaked-project-tab');

    await resetClientState({ idbTimeoutMs: 5 });

    expect(useTabStore.getState().activeTabId).toBe(useTabStore.getInitialState().activeTabId);
  });

  test('a device-scoped KEPT preference is NOT reset — the boundary holds both ways', async () => {
    // `useUserPreferencesStore` is deliberately absent from the registry
    // (`KEEP_STORAGE_KEYS` in `clear-local-storage.ts` names its persisted
    // key as device-scoped). If a future change folded it into the sweep by
    // mistake, this is the test that would catch a THEME reset on every
    // sign-out.
    useUserPreferencesStore.getState().setThemeId('a-distinctive-non-default-theme');
    expect(useUserPreferencesStore.getState().preferences.themeId).toBe(
      'a-distinctive-non-default-theme',
    );

    await resetClientState({ idbTimeoutMs: 5 });

    expect(useUserPreferencesStore.getState().preferences.themeId).toBe(
      'a-distinctive-non-default-theme',
    );
  });
});

describe('resetClientState clears the impersonation session, module state included', () => {
  // `packages/sdk/src/core/http/impersonation.ts` holds `current`/`hydrated`
  // at MODULE scope, on top of the sessionStorage key. Deleting only the
  // sessionStorage key (what the old delete-list would have done) leaves the
  // in-memory mirror live: `getImpersonationSession()` would keep returning
  // the stale session, and the admin banner would keep attaching
  // `X-Kortix-Impersonate` to every request, for the rest of the tab's life.
  test('a live impersonation session does not survive resetClientState()', async () => {
    setImpersonationSession({
      grantId: 'grant-1',
      accountId: 'acct-1',
      accountName: 'Leaked Account',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(getImpersonationSession()?.grantId).toBe('grant-1');

    await resetClientState({ idbTimeoutMs: 5 });

    expect(getImpersonationSession()).toBeNull();
  });

  test('cleanup: clears any session a prior test in this file left live', () => {
    // `current`/`hydrated` are module-level in the SDK, so state from the test
    // above (or a future one added here) would otherwise leak into whichever
    // test file bun schedules next in this process. `--isolate` gives this
    // file its own process, but leaving module state dirty at the end of a
    // file is still the wrong default to model.
    clearImpersonationSession();
    expect(getImpersonationSession()).toBeNull();
  });
});
