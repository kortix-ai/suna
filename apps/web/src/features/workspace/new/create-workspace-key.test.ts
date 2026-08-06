import { beforeEach, describe, expect, test } from 'bun:test';

import { attemptKeyFor, clearAttemptKey } from './create-workspace-key';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
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
