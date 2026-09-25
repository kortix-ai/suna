import { afterEach, describe, expect, test } from 'bun:test';
import {
  registerDisposableKey,
  pruneAllRegisteredCaches,
  safeGetItem,
  safeRemoveItem,
  safeSessionGetItem,
  safeSessionRemoveItem,
  safeSessionSetItem,
  safeSetItem,
  ScopedCache,
} from './managed-storage';
// Constructing the SDK session caches registers their families here.
import { LS_SESSIONS } from '../../react/use-opencode-sessions/shared';

// Each case installs its own `window` and bare storage globals. Put the
// originals back so no mutation leaks into another case.
const globals = globalThis as Record<string, unknown>;
const ORIGINAL = {
  window: globals.window,
  localStorage: globals.localStorage,
  sessionStorage: globals.sessionStorage,
};

afterEach(() => {
  globals.window = ORIGINAL.window;
  globals.localStorage = ORIGINAL.localStorage;
  globals.sessionStorage = ORIGINAL.sessionStorage;
});

/** A Storage with a byte budget that throws a quota error on overflow, as a browser does. */
class BudgetStorage {
  private map = new Map<string, string>();
  constructor(private readonly budget: number) {}

  private usedBytes(skipKey: string): number {
    let total = 0;
    for (const [k, v] of this.map) if (k !== skipKey) total += k.length + v.length;
    return total;
  }

  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.usedBytes(k) + k.length + v.length > this.budget) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** A browser: `window.localStorage` and the bare global are the same object. */
function install(budget: number): BudgetStorage {
  const store = new BudgetStorage(budget);
  globals.window = { localStorage: store, sessionStorage: store };
  globals.localStorage = store;
  globals.sessionStorage = store;
  return store;
}

/**
 * An embedded WebView that resolves the storage accessors to `null` instead of
 * throwing. `typeof null === 'object'`, so a `typeof localStorage` probe
 * reports storage as available.
 */
function installNullStorage(): void {
  globals.window = { localStorage: null, sessionStorage: null };
  globals.localStorage = null;
  globals.sessionStorage = null;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('safeSetItem', () => {
  test('persists when there is room', () => {
    install(10_000);
    expect(safeSetItem('k', 'v')).toBe(true);
    expect(safeGetItem('k')).toBe('v');
  });

  test('returns false without throwing when nothing can be reclaimed', () => {
    install(5);
    expect(safeSetItem('toolong', 'value')).toBe(false);
  });

  test('quota pressure evicts a disposable family before failing the write', () => {
    const store = install(150);
    new ScopedCache<string>('fam_bloat', 50).set('s1', 'x'.repeat(80));

    expect(safeSetItem('durable-key', 'y'.repeat(80))).toBe(true);
    expect(store.getItem('durable-key')).toBe('y'.repeat(80));
    expect(store.keys().some((k) => k.startsWith('fam_bloat:'))).toBe(false);
  });

  test('exact-key disposables are evicted only after scoped families', () => {
    const store = install(200);
    registerDisposableKey('blob-key');
    store.setItem('blob-key', 'b'.repeat(60));
    new ScopedCache<string>('fam_pri', 50).set('old', 's'.repeat(60));

    expect(safeSetItem('durable2', 'd'.repeat(60))).toBe(true);
    expect(store.keys().some((k) => k.startsWith('fam_pri:'))).toBe(false);
    expect(store.getItem('blob-key')).toBe('b'.repeat(60));
  });
});

describe('ScopedCache', () => {
  test('caps a family to its maxScopes, evicting the oldest write', async () => {
    const store = install(1_000_000);
    const cache = new ScopedCache<number>('fam_cap', 2);
    cache.set('a', 1);
    await tick();
    cache.set('b', 2);
    await tick();
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(store.keys().filter((k) => k.startsWith('fam_cap:'))).toHaveLength(2);
  });

  test('treats a legacy un-wrapped entry as a miss', () => {
    const store = install(1_000_000);
    store.setItem('fam_legacy:x', JSON.stringify([1, 2, 3]));
    expect(new ScopedCache<number[]>('fam_legacy', 4).get('x')).toBeUndefined();
  });
});

describe('SDK-registered session caches', () => {
  test('quota reclaim evicts the kortix_cache_sessions family', () => {
    const store = install(300);
    store.setItem(`${LS_SESSIONS}:sbx_a`, JSON.stringify({ v: [], t: 1, pad: 'x'.repeat(150) }));

    expect(safeSetItem('durable-pref', 'p'.repeat(120))).toBe(true);
    expect(store.keys().some((k) => k.startsWith(`${LS_SESSIONS}:`))).toBe(false);
  });

  test('pruneAllRegisteredCaches caps the kortix_cache_sessions family', () => {
    const store = install(1_000_000);
    // The sessions cache keeps the 4 most recent sandboxes.
    for (let t = 1; t <= 6; t++) {
      store.setItem(`${LS_SESSIONS}:sbx_${t}`, JSON.stringify({ v: [], t }));
    }

    pruneAllRegisteredCaches();

    expect(store.keys().filter((k) => k.startsWith(`${LS_SESSIONS}:`)).sort()).toEqual([
      `${LS_SESSIONS}:sbx_3`,
      `${LS_SESSIONS}:sbx_4`,
      `${LS_SESSIONS}:sbx_5`,
      `${LS_SESSIONS}:sbx_6`,
    ]);
  });
});

describe('null storage accessor (embedded WebView)', () => {
  test('localStorage helpers never throw and report empty', () => {
    installNullStorage();
    expect(safeGetItem('k')).toBeNull();
    expect(safeSetItem('k', 'v')).toBe(false);
    expect(() => safeRemoveItem('k')).not.toThrow();
  });

  test('ScopedCache and pruneAllRegisteredCaches never throw', () => {
    installNullStorage();
    const cache = new ScopedCache<number>('fam_null', 4);
    expect(() => cache.set('s', 1)).not.toThrow();
    expect(cache.get('s')).toBeUndefined();
    expect(() => cache.prune()).not.toThrow();
    expect(() => pruneAllRegisteredCaches()).not.toThrow();
  });

  test('sessionStorage helpers never throw and report empty', () => {
    installNullStorage();
    expect(safeSessionGetItem('k')).toBeNull();
    expect(safeSessionSetItem('k', 'v')).toBe(false);
    expect(() => safeSessionRemoveItem('k')).not.toThrow();
  });
});

describe('storage whose reads throw after it resolves', () => {
  // Every Storage member throws, as a revoked or partitioned storage can.
  function installThrowingStorage(): void {
    const fail = (): never => {
      throw new Error('SecurityError: storage is not available');
    };
    const throwing = {
      get length(): number {
        return fail();
      },
      key: fail,
      getItem: fail,
      setItem: fail,
      removeItem: fail,
    };
    globals.window = { localStorage: throwing, sessionStorage: throwing };
    globals.localStorage = throwing;
    globals.sessionStorage = throwing;
  }

  test('safeSetItem reports false instead of throwing from its quota reclaim', () => {
    installThrowingStorage();
    new ScopedCache<number>('fam_throwing', 2);
    expect(safeSetItem('k', 'v')).toBe(false);
  });

  test('ScopedCache and pruneAllRegisteredCaches never throw', () => {
    installThrowingStorage();
    const cache = new ScopedCache<number>('fam_throwing_prune', 2);
    expect(() => cache.set('s', 1)).not.toThrow();
    expect(() => pruneAllRegisteredCaches()).not.toThrow();
  });
});

describe('sessionStorage helpers', () => {
  test('write, read and remove through window.sessionStorage', () => {
    const store = install(10_000);
    expect(safeSessionSetItem('s', '1')).toBe(true);
    expect(safeSessionGetItem('s')).toBe('1');
    expect(store.getItem('s')).toBe('1');
    safeSessionRemoveItem('s');
    expect(safeSessionGetItem('s')).toBeNull();
  });
});
