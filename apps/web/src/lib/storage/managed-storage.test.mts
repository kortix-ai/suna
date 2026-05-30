import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A faithful-enough localStorage mock: enforces a byte budget and throws a
 * QuotaExceededError-like error on overflow, exactly like a real browser.
 */
class MockStorage {
  private map = new Map<string, string>();
  private readonly budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }

  private usedBytes(skipKey?: string): number {
    let total = 0;
    for (const [k, v] of this.map) {
      if (k === skipKey) continue;
      total += k.length + v.length;
    }
    return total;
  }

  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
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

function install(budget: number): MockStorage {
  const store = new MockStorage(budget);
  (globalThis as any).window = {};
  (globalThis as any).localStorage = store;
  return store;
}

// The module reads localStorage off globalThis lazily on each call, and module
// state (registered families, timestamps) is fine to share across cases. We
// import once and re-install a fresh storage per test.
const mod = await import('./managed-storage.ts');

test('safeSetItem never throws and persists when there is room', () => {
  install(10_000);
  const ok = mod.safeSetItem('k', 'v');
  assert.equal(ok, true);
  assert.equal(mod.safeGetItem('k'), 'v');
});

test('safeSetItem returns false (no throw) when nothing can be reclaimed', () => {
  install(5);
  const ok = mod.safeSetItem('toolong', 'value');
  assert.equal(ok, false); // could not fit, but did not throw
});

test('ScopedCache caps a family to its maxScopes (LRU by write time)', async () => {
  const store = install(1_000_000);
  const cache = new mod.ScopedCache<number>('fam_cap', 2);
  cache.set('a', 1);
  await new Promise((r) => setTimeout(r, 5));
  cache.set('b', 2);
  await new Promise((r) => setTimeout(r, 5));
  cache.set('c', 3); // should evict 'a', the oldest

  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  const famKeys = store.keys().filter((k) => k.startsWith('fam_cap:'));
  assert.equal(famKeys.length, 2);
});

test('quota pressure evicts another family before failing the write', () => {
  const store = install(150);
  // Fill the bucket with a disposable scoped-cache family.
  const bloat = new mod.ScopedCache<string>('fam_bloat', 50);
  bloat.set('s1', 'x'.repeat(80));

  // A durable (unregistered) write that only fits once the bloat is evicted.
  const ok = mod.safeSetItem('durable-key', 'y'.repeat(80));
  assert.equal(ok, true);
  assert.equal(store.getItem('durable-key'), 'y'.repeat(80));
  // The disposable family entry was sacrificed.
  assert.equal(store.keys().some((k) => k.startsWith('fam_bloat:')), false);
});

test('ScopedCache treats legacy un-wrapped entries as a miss', () => {
  const store = install(1_000_000);
  store.setItem('fam_legacy:x', JSON.stringify([1, 2, 3])); // raw array, no {v,t}
  const cache = new mod.ScopedCache<number[]>('fam_legacy', 4);
  assert.equal(cache.get('x'), undefined);
});

test('exact-key disposables are evicted only after scoped families', () => {
  const store = install(200);
  mod.registerDisposableKey('blob-key');
  store.setItem('blob-key', 'b'.repeat(60));
  const scoped = new mod.ScopedCache<string>('fam_pri', 50);
  scoped.set('old', 's'.repeat(60));

  // Need room for a durable write; the scoped family should go first.
  const ok = mod.safeSetItem('durable2', 'd'.repeat(60));
  assert.equal(ok, true);
  assert.equal(store.keys().some((k) => k.startsWith('fam_pri:')), false); // scoped evicted
  assert.equal(store.getItem('blob-key'), 'b'.repeat(60)); // blob survived
});
