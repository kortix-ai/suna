import { afterEach, beforeEach, expect, test } from 'bun:test';

import * as sdk from '@kortix/sdk/internal/managed-storage'; // eslint-disable-line no-restricted-imports

import * as web from './managed-storage';

// The SDK registers its session, agent, command and provider caches in its own
// disposable registry. The web app reclaims quota and prunes on boot through
// `@/lib/storage/managed-storage`. Both names must reach one registry, or the
// web reclaim never sees the largest caches. Behavior cases live in
// packages/sdk/src/platform/storage/managed-storage.test.ts.

class FakeStorage {
  private map = new Map<string, string>();
  constructor(private readonly budget = Number.POSITIVE_INFINITY) {}
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    let used = key.length + value.length;
    for (const [k, v] of this.map) if (k !== key) used += k.length + v.length;
    if (used > this.budget) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

const globals = globalThis as Record<string, unknown>;
const previous = { window: globals.window, localStorage: globals.localStorage };

function install(budget?: number): FakeStorage {
  const storage = new FakeStorage(budget);
  globals.window = { localStorage: storage };
  globals.localStorage = storage;
  return storage;
}

beforeEach(() => install());
afterEach(() => {
  globals.window = previous.window;
  globals.localStorage = previous.localStorage;
});

test('the web import is the SDK module, not a copy', () => {
  expect(web.ScopedCache).toBe(sdk.ScopedCache);
  expect(web.safeSetItem).toBe(sdk.safeSetItem);
  expect(web.pruneAllRegisteredCaches).toBe(sdk.pruneAllRegisteredCaches);
});

test('the web boot prune caps a family registered through the SDK', () => {
  const storage = install();
  const family = 'web_shim_sdk_family';
  const cache = new sdk.ScopedCache<number>(family, 1);
  storage.setItem(`${family}:old`, JSON.stringify({ v: 1, t: 1 }));
  storage.setItem(`${family}:new`, JSON.stringify({ v: 2, t: 2 }));

  web.pruneAllRegisteredCaches();

  expect(storage.keys().filter((k) => k.startsWith(`${family}:`))).toEqual([`${family}:new`]);
  expect(cache.get('new')).toBe(2);
});

test('web quota reclaim evicts a family registered through the SDK', () => {
  const storage = install(200);
  const family = 'web_shim_sdk_reclaim';
  sdk.registerDisposableFamily(family);
  storage.setItem(`${family}:sbx`, JSON.stringify({ v: 'x'.repeat(100), t: 1 }));

  expect(web.safeSetItem('durable-pref', 'p'.repeat(80))).toBe(true);
  expect(storage.keys().some((k) => k.startsWith(`${family}:`))).toBe(false);
});
