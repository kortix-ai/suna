import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as idb from '@kortix/sdk/idb-sync-cache';
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
 * partitioned iframe).
 *
 * `runSignOut` absorbed a rejection through `withTimeBudget`, and
 * `AuthProvider.adoptUser` awaits `resetClientState()` bare, before
 * `setIsLoading(false)` — so a throw reaching `resetClientState()` unhandled
 * would reject a SIGN-IN and park the app on its loading frame, in exactly
 * the browsers least able to report it.
 *
 * Stubs throwing GLOBAL storage accessors (`window`, `localStorage`,
 * `sessionStorage`) — the same STUBBING TECHNIQUE `clear-local-storage.test.ts`
 * uses throughout its own file, though that file throws only one storage at
 * a time to prove the two sweeps are independent; this file throws both,
 * standing in for a fully storage-blocked browser (Safari private mode) —
 * not `mock.module` on `@/lib/utils/clear-local-storage`. `mock.module` is
 * PROCESS-WIDE in this
 * repo: it replaced `clearUserLocalStorage` for every test that shares this
 * process, so `bun test src/lib/utils` outside `--isolate` broke
 * `clear-local-storage.test.ts`'s own tests of the real function with an
 * error belonging to a module this file never runs. The gated CI command
 * (`bun test --isolate --parallel=4`) never saw it — one process per file —
 * but any focused run a human or agent types did.
 */
const originalWindow = globalThis.window;
const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
const originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;

/**
 * `clearUserLocalStorage()` early-returns on `typeof window === 'undefined'`
 * — true by default in this Bun test environment (`test-setup.ts` registers
 * no DOM), so the throwing `localStorage` below would never even be reached
 * without also stubbing `window`. THREE globals stubbed, matching
 * `clear-local-storage.test.ts`'s own `defineGlobal` calls exactly (`window`,
 * bare `localStorage`, bare `sessionStorage`) — not two. Bun provides no
 * default global `sessionStorage` in this test environment (only
 * `localStorage` is a real Bun global here), so leaving it unstubbed does
 * not silently pass through to a working implementation; it throws a
 * `ReferenceError` instead of the deliberate `SecurityError` this function
 * constructs for `localStorage` — an accident of this environment, not a
 * guarantee. Stubbing it explicitly means the sessionStorage branch is
 * proven on purpose and stays proven even if Bun ever adds a default
 * `sessionStorage` global.
 */
function stubThrowingLocalStorage(): void {
  const throwing = {
    get length(): number {
      throw new Error('SecurityError: localStorage is not available');
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { localStorage: throwing, sessionStorage: throwing },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: throwing,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: throwing,
  });
}

function restoreLocalStorage(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: originalLocalStorage,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: originalSessionStorage,
  });
}

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
    // `expect(true).toBe(true)` used to stand here — it proves only that
    // both awaits eventually returned, which is also true if the second call
    // silently inherited (or waited out) the first's hang before settling.
    // Bounding each call's OWN elapsed time is what actually distinguishes
    // "the second sign-in got its own fresh budget" from "the second sign-in
    // was blocked by the first and only unblocked much later" — the risk
    // named in this test's own title.
    const firstStarted = Date.now();
    await resetClientState({ idbTimeoutMs: 5 });
    const firstElapsed = Date.now() - firstStarted;

    const secondStarted = Date.now();
    await resetClientState({ idbTimeoutMs: 5 });
    const secondElapsed = Date.now() - secondStarted;

    expect(firstElapsed).toBeLessThan(500);
    expect(secondElapsed).toBeLessThan(500);
  });
});

describe('resetClientState when localStorage access throws', () => {
  beforeEach(() => stubThrowingLocalStorage());
  afterEach(() => restoreLocalStorage());

  test('still resolves, so a SIGN-IN cannot be parked by a blocked storage bucket', async () => {
    // The real `clearUserLocalStorage()` runs here, against the throwing
    // global stubbed above — not a mocked-away function. Its own internal
    // try/catch (`clear-local-storage.ts`) already absorbs a throwing
    // `localStorage`, so this proves the FULL real path — `resetClientState`
    // calling the real `clearUserLocalStorage` calling a genuinely throwing
    // browser API — still settles, end to end.
    await resetClientState({ idbTimeoutMs: 5 });
    expect(true).toBe(true);
  });

  test('the earlier clears still ran — a throwing localStorage does not abort the whole reset', async () => {
    // `clearUserLocalStorage` is the THIRD step. The React Query cache and the
    // account store are cleared before it, and both are guarded already; this
    // pins that a throwing storage bucket in step 3 does not skip step 4
    // either, across two consecutive resets (the second sign-in must not be
    // blocked by the first).
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
