import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { clearUserLocalStorage, isAppOwnedStorageKey } from '@/lib/utils/clear-local-storage';
import { stashSignOutNotice, takeSignOutNotice } from './sign-out-notice';

/**
 * A minimal but FUNCTIONAL `Storage` — real `length`/`key(i)` iteration —
 * same fixture shape as `clear-local-storage.test.ts`.
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

const originalWindow = globalThis.window;const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
const originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;

let fakeSessionStorage: FakeStorage;
let fakeLocalStorage: FakeStorage;

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  fakeSessionStorage = new FakeStorage();
  fakeLocalStorage = new FakeStorage();
  defineGlobal('window', { sessionStorage: fakeSessionStorage });
  defineGlobal('sessionStorage', fakeSessionStorage);
  // `clearUserLocalStorage` sweeps BOTH storages and reads `localStorage` as a
  // bare identifier; without a stub the sweep test prints a caught
  // ReferenceError on every run.
  defineGlobal('localStorage', fakeLocalStorage);
});

afterEach(() => {
  defineGlobal('window', originalWindow);
  defineGlobal('localStorage', originalLocalStorage);
  defineGlobal('sessionStorage', originalSessionStorage);
});

describe('sign-out notice', () => {
  test('the key is app-owned, so the sign-out sweep cleans a stale notice', () => {
    // The sweep's ownership test (`isAppOwnedStorageKey`) must claim this key:
    // a notice written before a sweep (an interrupted sign-out) must never
    // survive to surface under the NEXT user of this tab.
    expect(isAppOwnedStorageKey('kortix-sign-out-notice')).toBe(true);
  });

  test('a stashed notice is read exactly once', () => {
    stashSignOutNotice();

    expect(takeSignOutNotice()).toBe(true);
    expect(takeSignOutNotice()).toBe(false);
  });

  test('an empty tab has no notice', () => {
    expect(takeSignOutNotice()).toBe(false);
  });

  test('the sign-out storage sweep removes a stashed notice', () => {
    // The key sits under an app prefix, so the sweep owns it: a notice left
    // behind by an interrupted sign-out must never surface under the NEXT
    // user of this tab. The survival rule the sequence relies on is the
    // OTHER side of this: the sequence writes the notice AFTER that sweep
    // (pinned by the ordering assertion in `sign-out-sequence.test.ts`).
    stashSignOutNotice();
    clearUserLocalStorage();

    expect(takeSignOutNotice()).toBe(false);
  });

  test('refused storage access is silent on both sides', () => {
    // Safari private mode and partitioned iframes throw on access. A notice
    // that cannot be stashed (or read) degrades to the pre-fix behaviour —
    // the sign-out itself is unaffected — and must not throw.
    const refusing = new FakeStorage();
    refusing.setItem = () => {
      throw new Error('quota');
    };
    refusing.getItem = () => {
      throw new Error('denied');
    };
    defineGlobal('sessionStorage', refusing);
    defineGlobal('window', { sessionStorage: refusing });

    expect(() => stashSignOutNotice()).not.toThrow();
    expect(takeSignOutNotice()).toBe(false);
  });
});
