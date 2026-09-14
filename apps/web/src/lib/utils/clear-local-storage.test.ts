import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  APP_STORAGE_PREFIXES,
  KEEP_STORAGE_KEYS,
  clearUserLocalStorage,
  isAppOwnedStorageKey,
  isKeptStorageKey,
} from './clear-local-storage';

/**
 * A minimal but FUNCTIONAL `Storage` — real `length`/`key(i)` iteration, not
 * the `key: () => null, length: 0` stub some other fixtures in this repo use
 * (fine for a Map-backed `getItem`/`setItem` test, not for code that walks
 * every key via `storage.length`/`storage.key(i)`, which `sweepStorage()`
 * does).
 */
class FakeStorage implements Storage {
  private entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.has(key) ? (this.entries.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

/**
 * Hard-coded, independent of the exports under test. A loop written
 * `for (const x of APP_STORAGE_PREFIXES)` looks like coverage but is a
 * VACUOUS PASS the moment that array is emptied — zero iterations, zero
 * assertions, green suite. Mutation-tested: emptying `KEEP_STORAGE_KEYS` in
 * `clear-local-storage.ts` left an earlier version of this file's tests
 * fully green. These two literals, plus the `toEqual` checks below, are what
 * make that mutation fail instead.
 */
const EXPECTED_PREFIXES = [
  'kortix-',
  'kortix.',
  'kortix:',
  'kortix_',
  'opencode-',
  'opencode_',
  'files-view-mode',
  'files-sort-',
  'maintenance-dismissed-',
];
const EXPECTED_KEEP_KEYS = [
  'kortix-sound-preferences',
  'kortix-user-preferences',
  'kortix-web-notifications',
];

const originalWindow = globalThis.window;
const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
const originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;

let fakeLocalStorage: FakeStorage;
let fakeSessionStorage: FakeStorage;

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  fakeLocalStorage = new FakeStorage();
  fakeSessionStorage = new FakeStorage();
  // A real browser's `localStorage`/`sessionStorage` are reachable both as
  // bare identifiers and as `window.localStorage` — this app's code (and
  // Bun's own global `localStorage`, which is backed by SQLite, not a real
  // browser bucket) mixes both spellings across files, so both are stubbed.
  defineGlobal('window', { localStorage: fakeLocalStorage, sessionStorage: fakeSessionStorage });
  defineGlobal('localStorage', fakeLocalStorage);
  defineGlobal('sessionStorage', fakeSessionStorage);
});

afterEach(() => {
  defineGlobal('window', originalWindow);
  defineGlobal('localStorage', originalLocalStorage);
  defineGlobal('sessionStorage', originalSessionStorage);
});

describe('isAppOwnedStorageKey', () => {
  test('APP_STORAGE_PREFIXES is exactly the documented set — catches silent drift either way', () => {
    expect([...APP_STORAGE_PREFIXES].sort()).toEqual([...EXPECTED_PREFIXES].sort());
  });

  test('matches every documented prefix', () => {
    // Enumerated against the LITERAL above, not `APP_STORAGE_PREFIXES` itself
    // — looping over the export under test means emptying it drops the loop
    // to zero iterations and passes vacuously (see the comment on
    // `EXPECTED_PREFIXES`).
    for (const prefix of EXPECTED_PREFIXES) {
      expect(isAppOwnedStorageKey(`${prefix}anything`)).toBe(true);
    }
  });

  test('rejects a key with no app prefix', () => {
    expect(isAppOwnedStorageKey('theme')).toBe(false);
    expect(isAppOwnedStorageKey('some-third-party-widget-id')).toBe(false);
  });

  test('a prefix must anchor the START of the key, not appear anywhere in it', () => {
    // `sb-kortix-auth-token` (the Supabase auth cookie's localStorage-shaped
    // name in some SDK versions) contains "kortix-" but must NOT match —
    // `dropAuthCookie` owns that key exclusively.
    expect(isAppOwnedStorageKey('sb-kortix-auth-token')).toBe(false);
  });
});

describe('isKeptStorageKey', () => {
  test('KEEP_STORAGE_KEYS is exactly the documented set — catches silent drift either way', () => {
    expect([...KEEP_STORAGE_KEYS].sort()).toEqual([...EXPECTED_KEEP_KEYS].sort());
  });

  test('the three documented device-scoped keys are kept', () => {
    // Against the LITERAL, not `KEEP_STORAGE_KEYS` — see `EXPECTED_KEEP_KEYS`.
    for (const key of EXPECTED_KEEP_KEYS) {
      expect(isKeptStorageKey(key)).toBe(true);
    }
  });

  test('a KEEP key is exact-match, not a prefix', () => {
    expect(isKeptStorageKey('kortix-sound-preferences-extra')).toBe(false);
  });

  test('rejects anything not on the list', () => {
    expect(isKeptStorageKey('kortix-browser-recents')).toBe(false);
  });
});

describe('clearUserLocalStorage', () => {
  test('sweeps app-owned keys from localStorage', () => {
    fakeLocalStorage.setItem('kortix-browser-recents', '[]');
    fakeLocalStorage.setItem('kortix.currentAccount', '{}');
    fakeLocalStorage.setItem('opencode-model-store-v1', '{}');
    fakeLocalStorage.setItem('files-view-mode', 'grid');
    fakeLocalStorage.setItem('maintenance-dismissed-2026-01-01', 'true');

    clearUserLocalStorage();

    expect(fakeLocalStorage.length).toBe(0);
  });

  test('sweeps app-owned keys from sessionStorage too — the impersonation-key class of bug', () => {
    // `kortix.impersonation` (the SDK's sessionStorage key) is the confirmed
    // leak this sweep exists to close on the disk side; a fixture key in the
    // same shape stands in for it here without depending on `@kortix/sdk`.
    fakeSessionStorage.setItem('kortix.impersonation', '{"grantId":"g1"}');
    fakeSessionStorage.setItem('kortix:suppress-auto-project', '1');

    clearUserLocalStorage();

    expect(fakeSessionStorage.length).toBe(0);
  });

  test('keeps KEEP_STORAGE_KEYS in both storages', () => {
    for (const key of EXPECTED_KEEP_KEYS) {
      fakeLocalStorage.setItem(key, '{}');
    }

    clearUserLocalStorage();

    for (const key of EXPECTED_KEEP_KEYS) {
      expect(fakeLocalStorage.getItem(key)).not.toBeNull();
    }
    expect(fakeLocalStorage.length).toBe(EXPECTED_KEEP_KEYS.length);
  });

  test('leaves a key with no app prefix untouched', () => {
    fakeLocalStorage.setItem('theme', 'dark');
    fakeLocalStorage.setItem('some-unrelated-widget', 'x');

    clearUserLocalStorage();

    expect(fakeLocalStorage.getItem('theme')).toBe('dark');
    expect(fakeLocalStorage.getItem('some-unrelated-widget')).toBe('x');
  });

  test('never touches document.cookie — `kortix_last_project` cannot be reached from here', () => {
    // Load-bearing per ruling R12 (see `reset-client-state.ts`'s header and
    // `lib/auth/sign-out-navigation.test.ts`'s tripwire): this function must
    // have NO way to write a cookie, not merely "does not currently write
    // this one". A getter that throws on read proves the code path is never
    // exercised, not just that today's keys happen to survive.
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      get cookie(): string {
        throw new Error('clearUserLocalStorage must never touch document.cookie');
      },
    } as unknown as PropertyDescriptor);

    try {
      expect(() => clearUserLocalStorage()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'document', {
        value: originalDocument,
        configurable: true,
        writable: true,
      });
    }
  });

  test('does nothing (and does not throw) with no window', () => {
    defineGlobal('window', undefined);
    fakeLocalStorage.setItem('kortix-browser-recents', '[]');

    expect(() => clearUserLocalStorage()).not.toThrow();
    expect(fakeLocalStorage.getItem('kortix-browser-recents')).toBe('[]');
  });

  test('a throwing localStorage does not stop the sessionStorage sweep', () => {
    fakeSessionStorage.setItem('kortix.impersonation', '{}');
    defineGlobal('localStorage', {
      get length(): number {
        throw new Error('SecurityError');
      },
    });

    expect(() => clearUserLocalStorage()).not.toThrow();
    expect(fakeSessionStorage.length).toBe(0);
  });
});
