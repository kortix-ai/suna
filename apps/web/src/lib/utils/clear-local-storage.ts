/**
 * Prefixes this app writes `localStorage` / `sessionStorage` keys under.
 *
 * A key that starts with one of these belongs to Kortix, not the browser or a
 * third party, so it is safe — and, unless it is on `KEEP_STORAGE_KEYS`,
 * REQUIRED — to erase on an identity change. This is the single source of
 * truth for "does this app own this key": `sweepStorage()` below uses it to
 * decide what to delete, and `persisted-store-coverage.test.ts` uses the
 * SAME constant (imported, never re-typed) to prove every persisted zustand
 * store's key falls under one of these prefixes or is explicitly kept. A
 * prefix added here without a matching KEEP entry starts sweeping that store
 * on the next sign-out; a store whose name matches neither list fails that
 * test instead of silently surviving forever.
 *
 * `'files-view-mode'` and `'maintenance-dismissed-'` are not `kortix-`
 * prefixed — they predate that convention — so they are named directly rather
 * than dropped, which would silently stop sweeping them.
 */
export const APP_STORAGE_PREFIXES = [
  'kortix-',
  'kortix.',
  'kortix:',
  'kortix_',
  'opencode-',
  'opencode_',
  'files-view-mode',
  'files-sort-',
  'maintenance-dismissed-',
] as const;

/**
 * Keys that DO match a prefix above but hold a genuinely device-scoped
 * preference — theme, sound, notification permission — not anything tied to
 * the signed-in identity. These survive the sweep on purpose: the next
 * account on this browser inherits the same physical device, so re-asking
 * "dark or light?" on every sign-in would be the regression, not the fix.
 *
 * `persisted-store-coverage.test.ts` asserts every persisted zustand store
 * whose name is on this list has NO `registerPersistedStore(...)` call
 * (see `persisted-store-registry.ts`) — the disk KEEP and the in-memory
 * exclusion must never drift apart.
 */
export const KEEP_STORAGE_KEYS: ReadonlySet<string> = new Set([
  'kortix-sound-preferences',
  'kortix-user-preferences',
  'kortix-web-notifications',
]);

/** Whether `key` is owned by this app (matches a prefix above). */
export function isAppOwnedStorageKey(key: string): boolean {
  return APP_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Whether `key` matches an app prefix but is deliberately kept. */
export function isKeptStorageKey(key: string): boolean {
  return KEEP_STORAGE_KEYS.has(key);
}

/**
 * Delete every app-owned key from `storage`, except the kept ones.
 *
 * Snapshots the key list before removing anything: mutating a `Storage`
 * object while iterating its live index (`storage.key(i)`) skips entries, the
 * classic "removing from an array while looping over it" bug.
 */
function sweepStorage(storage: Storage): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    if (isAppOwnedStorageKey(key) && !isKeptStorageKey(key)) {
      storage.removeItem(key);
    }
  }
}

/**
 * Wipe every per-user key this app has ever written to `localStorage` or
 * `sessionStorage`, keeping only the device-scoped preferences on
 * `KEEP_STORAGE_KEYS`.
 *
 * A PREFIX sweep, not a literal delete-list: the list this replaced named
 * seven keys, five of which had had no writer for months while none of the
 * fifteen persisted zustand stores added since it was written were named at
 * all — `kortix-browser-recents` (the last 8 URLs any user browsed in-app,
 * rendered to the NEXT user as a clickable list) among them. A key this app
 * writes under one of `APP_STORAGE_PREFIXES` is swept the moment it exists,
 * with no second commit required to remember it.
 *
 * Does NOT touch cookies. `kortix_last_project` survives sign-out on purpose
 * — see `lib/onboarding/last-project-cookie.ts` and the tripwire test at
 * `lib/auth/sign-out-navigation.test.ts`.
 */
export const clearUserLocalStorage = () => {
  if (typeof window === 'undefined') return;

  // Independent try/catch per storage, deliberately not one try wrapping
  // both: `sessionStorage` holds the confirmed impersonation leak
  // (`kortix.impersonation`), so a `localStorage` access throwing first (Safari
  // private mode, a partitioned iframe) must not skip the sessionStorage sweep.
  try {
    sweepStorage(localStorage);
  } catch (error) {
    console.error('❌ Error clearing local storage:', error);
  }

  try {
    sweepStorage(sessionStorage);
  } catch (error) {
    console.error('❌ Error clearing session storage:', error);
  }
};
