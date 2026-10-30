import { beforeEach, describe, expect, test } from 'bun:test';

import {
  attemptKeyFor,
  clearAttemptKey,
  resetAttemptKeyMemoryFallbackForTests,
} from './create-workspace-key';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  // Fix round 1: `attemptKeyFor`'s in-memory fallback (for when
  // `localStorage` is unavailable) is module-level state — without this
  // reset, test cases below that reuse `'acct-1:suna-web'` while storage is
  // unavailable would leak a minted key from one case into the next.
  resetAttemptKeyMemoryFallbackForTests();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe('attemptKeyFor', () => {
  test('returns the same key for the same attempt — a retry must not duplicate', () => {
    const first = attemptKeyFor('acct-1:suna-web', 1_000);
    const second = attemptKeyFor('acct-1:suna-web', 2_000);
    expect(second).toBe(first);
  });

  test('returns a different key for a different attempt', () => {
    const a = attemptKeyFor('acct-1:suna-web', 1_000);
    const b = attemptKeyFor('acct-1:kortix-api', 1_000);
    expect(b).not.toBe(a);
  });

  test('mints a fresh key once the old one has aged out', () => {
    const first = attemptKeyFor('acct-1:suna-web', 0);
    const later = attemptKeyFor('acct-1:suna-web', 60 * 60 * 1000 + 1);
    expect(later).not.toBe(first);
  });

  test('clearing forces the next call to mint a new key', () => {
    const first = attemptKeyFor('acct-1:suna-web', 1_000);
    clearAttemptKey('acct-1:suna-web');
    expect(attemptKeyFor('acct-1:suna-web', 1_000)).not.toBe(first);
  });

  test('survives storage being unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(typeof attemptKeyFor('acct-1:suna-web', 1_000)).toBe('string');
  });
});

/**
 * Fix round 1, finding 2: before `/new` exposed a clickable `retry` control
 * (Task 14, `new-workspace-page.tsx`), a storage-unavailable browser minting
 * a fresh key per `attemptKeyFor` call was low-frequency — at most once per
 * manual form resubmit. With a retry BUTTON, a user can click it repeatedly;
 * without this fallback, EVERY click would mint a new key and risk another
 * upstream managed repo — the exact failure idempotency exists to prevent.
 * Paired with the `typeof … 'string'` check above, which alone would still
 * pass if every call minted a brand new key.
 */
describe('attemptKeyFor: in-memory fallback when storage is unavailable', () => {
  test('two calls with the same fingerprint return the same key — a second retry click must not mint a fresh one', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    const first = attemptKeyFor('acct-1:suna-web', 1_000);
    const second = attemptKeyFor('acct-1:suna-web', 1_500);
    expect(second).toBe(first);
  });

  test('different fingerprints still get different keys without storage', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    const a = attemptKeyFor('acct-1:suna-web', 1_000);
    const b = attemptKeyFor('acct-1:kortix-api', 1_000);
    expect(b).not.toBe(a);
  });

  test('the fallback key ages out after the TTL, same as the localStorage path', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    const first = attemptKeyFor('acct-1:suna-web', 0);
    const later = attemptKeyFor('acct-1:suna-web', 60 * 60 * 1000 + 1);
    expect(later).not.toBe(first);
  });

  test('clearAttemptKey clears the fallback too — a success followed by a same-name create mints a genuinely new key, not the old one', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    const first = attemptKeyFor('acct-1:suna-web', 1_000);
    clearAttemptKey('acct-1:suna-web');
    const next = attemptKeyFor('acct-1:suna-web', 1_500);
    expect(next).not.toBe(first);
  });
});
