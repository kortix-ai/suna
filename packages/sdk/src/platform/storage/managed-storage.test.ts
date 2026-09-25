import { afterEach, describe, expect, test } from 'bun:test';
import {
  createSafeSessionJSONStorage,
  registerDisposableKey,
  pruneAllRegisteredCaches,
  safeGetItem,
  safeRemoveItem,
  safeSessionGetItem,
  safeSessionRemoveItem,
  safeSessionSetItem,
  safeSessionStorage,
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
 * A browser with a distinct object behind each accessor, so a case can prove a
 * helper touched the storage it names and left the other one alone.
 */
function installSeparate(budget: number): { local: BudgetStorage; session: BudgetStorage } {
  const local = new BudgetStorage(budget);
  const session = new BudgetStorage(budget);
  globals.window = { localStorage: local, sessionStorage: session };
  globals.localStorage = local;
  globals.sessionStorage = session;
  return { local, session };
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
  test('set, get and remove touch window.sessionStorage and never window.localStorage', () => {
    const { local, session } = installSeparate(10_000);

    expect(safeSessionSetItem('s', '1')).toBe(true);
    expect(session.getItem('s')).toBe('1');
    expect(local.keys()).toEqual([]);
    expect(safeSessionGetItem('s')).toBe('1');

    safeSessionRemoveItem('s');
    expect(session.keys()).toEqual([]);
    expect(safeSessionGetItem('s')).toBeNull();
    expect(local.keys()).toEqual([]);
  });

  test('a key present in both storages resolves and removes only the sessionStorage copy', () => {
    const { local, session } = installSeparate(10_000);
    local.setItem('both', 'local');
    session.setItem('both', 'session');

    expect(safeSessionGetItem('both')).toBe('session');
    safeSessionRemoveItem('both');
    expect(session.getItem('both')).toBeNull();
    expect(local.getItem('both')).toBe('local');
  });
});

describe('safeSessionStorage', () => {
  test('routes every StateStorage call to window.sessionStorage', () => {
    const { local, session } = installSeparate(10_000);

    safeSessionStorage.setItem('z', 'v');
    expect(session.getItem('z')).toBe('v');
    expect(safeSessionStorage.getItem('z')).toBe('v');
    safeSessionStorage.removeItem('z');
    expect(session.keys()).toEqual([]);
    expect(local.keys()).toEqual([]);
  });

  test('never throws on a null sessionStorage', () => {
    installNullStorage();
    expect(safeSessionStorage.getItem('z')).toBeNull();
    expect(() => safeSessionStorage.setItem('z', 'v')).not.toThrow();
    expect(() => safeSessionStorage.removeItem('z')).not.toThrow();
  });
});

describe('createSafeSessionJSONStorage', () => {
  test('round-trips JSON through window.sessionStorage only', () => {
    const { local, session } = installSeparate(10_000);
    const storage = createSafeSessionJSONStorage<{ n: number }>()!;

    storage.setItem('p', { state: { n: 1 }, version: 0 });
    expect(JSON.parse(session.getItem('p')!)).toEqual({ state: { n: 1 }, version: 0 });
    expect(storage.getItem('p')).toEqual({ state: { n: 1 }, version: 0 });

    storage.removeItem('p');
    expect(session.keys()).toEqual([]);
    expect(local.keys()).toEqual([]);
  });

  test('a null sessionStorage reads as empty and drops writes without throwing', () => {
    installNullStorage();
    const storage = createSafeSessionJSONStorage<{ n: number }>()!;
    expect(storage.getItem('p')).toBeNull();
    expect(() => storage.setItem('p', { state: { n: 1 }, version: 0 })).not.toThrow();
    expect(() => storage.removeItem('p')).not.toThrow();
  });
});
