// The point of this file, not a supporting cast member: walk every persisted
// zustand store under this directory and prove two things a future store
// cannot silently skip —
//   1. its disk key is either swept by `clearUserLocalStorage()`'s prefix
//      match or explicitly kept as device-scoped (`clear-local-storage.ts`);
//   2. unless it IS kept, its in-memory state is reset at sign-out — via its
//      OWN `registerPersistedStore(...)` call into `persisted-store-registry.ts`
//      (see that file's header for why `reset-client-state.ts` does not
//      import stores directly: a static import of `session-browser-store.ts`
//      once dragged a 3.8MB markdown renderer into every route's initial JS
//      chunk, caught by `connectors-page.chunk.test.ts`).
//
// Both checks are driven by extracting real names from real source files —
// this directory's listing, each file's `persist(..., { name: … })`, and each
// file's own `registerPersistedStore(...)` call — not by a hand-maintained
// mirror list that could drift from what actually exists. Adding a store here
// with an uncovered name, or one that never registers itself, fails a
// generated test by name.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isAppOwnedStorageKey,
  isKeptStorageKey,
} from '@/lib/utils/clear-local-storage';

const STORES_DIR = resolve(import.meta.dir);

/**
 * Every name a call matching `pattern` resolves to in `source`. `pattern`
 * must capture three groups: [1] the opening quote of a string literal (a
 * backreference anchor, discarded), [2] the literal's own text, [3] a bare
 * identifier — exactly one of [2] / [3] is set per match. A bare identifier
 * resolves against a `const <identifier> = '...'` declared in the SAME file.
 *
 * Shared by the `persist(` and `registerPersistedStore(` walks below — both
 * name a store the same two ways in this codebase (an inline literal, or a
 * `STORAGE_KEY` const).
 *
 * Throws rather than skipping when an identifier cannot be resolved: a call
 * this walker cannot read is a hole in the coverage guarantee, not something
 * to silently pass over.
 */
function extractNames(
  source: string,
  file: string,
  pattern: RegExp,
  callDescription: string,
): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    if (match[2] !== undefined) {
      names.push(match[2]);
      continue;
    }
    const identifier = match[3];
    const constMatch = source.match(
      new RegExp(`const\\s+${identifier}\\s*=\\s*(['"])((?:(?!\\1).)*)\\1`),
    );
    if (!constMatch) {
      throw new Error(
        `${file}: ${callDescription} names '${identifier}' but no matching ` +
          `'const ${identifier} = "..."' was found in the same file`,
      );
    }
    names.push(constMatch[2]);
  }
  return names;
}

/**
 * Every `persist(..., { name: <literal-or-const> })` name declared in
 * `source`. Two current stores write `name: STORAGE_KEY` — a module-level
 * `const` — rather than an inline literal; both forms resolve to the real
 * string value a `persist` `StateStorage` actually reads and writes.
 */
function extractPersistNames(source: string, file: string): string[] {
  if (!/\bpersist\(/.test(source)) return [];
  const names = extractNames(
    source,
    file,
    /\bname:\s*(?:(['"])((?:(?!\1).)*)\1|([A-Za-z_$][\w$]*))/g,
    'persist()',
  );
  if (names.length === 0) {
    throw new Error(`${file}: calls persist() but no 'name:' could be extracted`);
  }
  return names;
}

/**
 * Every `registerPersistedStore(<literal-or-const>, ...)` name declared in
 * `source`. Mirrors `extractPersistNames`'s two spellings.
 */
function extractRegisteredNames(source: string, file: string): string[] {
  return extractNames(
    source,
    file,
    /\bregisterPersistedStore\(\s*(?:(['"])((?:(?!\1).)*)\1|([A-Za-z_$][\w$]*))\s*,/g,
    'registerPersistedStore()',
  );
}

/** `export const useXStore = create<...>(` → `'useXStore'`, else null. */
function extractExportedHookName(source: string): string | null {
  const match = source.match(/export const (use[A-Za-z0-9_]*Store)\s*=\s*create[<(]/);
  return match ? match[1] : null;
}

function storeSourceFiles(): string[] {
  return readdirSync(STORES_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

interface DiscoveredStore {
  file: string;
  source: string;
  hookName: string | null;
  names: string[];
}

function discoverPersistedStores(): DiscoveredStore[] {
  const discovered: DiscoveredStore[] = [];
  for (const file of storeSourceFiles()) {
    const source = readFileSync(resolve(STORES_DIR, file), 'utf8');
    const names = extractPersistNames(source, file);
    if (names.length === 0) continue;
    discovered.push({ file, source, hookName: extractExportedHookName(source), names });
  }
  return discovered;
}

describe('every persisted zustand store is covered by the sign-out disk sweep', () => {
  const discovered = discoverPersistedStores();

  test('the walk actually finds persisted stores — an empty walk would pass everything', () => {
    // A floor on the CURRENT, real count (12 as of this test's writing) minus
    // slack, not an exact pin — an exact count would churn on every unrelated
    // store addition. The floor exists so a walker broken by a directory
    // rename or a changed `persist(` call shape fails loud instead of
    // quietly checking zero stores.
    expect(discovered.length).toBeGreaterThanOrEqual(11);
  });

  for (const store of discovered) {
    for (const name of store.names) {
      test(`${store.file} → '${name}' matches a swept prefix or is on KEEP_STORAGE_KEYS`, () => {
        expect(isAppOwnedStorageKey(name) || isKeptStorageKey(name)).toBe(true);
      });
    }
  }
});

describe('extractPersistNames resolves both spellings a persist() config uses here', () => {
  test('an inline string literal', () => {
    expect(
      extractPersistNames(`persist((set) => ({}), { name: 'literal-key' })`, 'fixture.ts'),
    ).toEqual(['literal-key']);
  });

  test('a module-level const reference', () => {
    const source = `const STORAGE_KEY = 'const-key';\npersist((set) => ({}), { name: STORAGE_KEY })`;
    expect(extractPersistNames(source, 'fixture.ts')).toEqual(['const-key']);
  });

  test('a file with no persist() call yields no names, instead of throwing', () => {
    expect(
      extractPersistNames(`export const useFoo = create(() => ({ x: 1 }));`, 'fixture.ts'),
    ).toEqual([]);
  });

  test('an unresolvable identifier throws, rather than silently reporting no names', () => {
    expect(() =>
      extractPersistNames(`persist((set) => ({}), { name: NEVER_DEFINED })`, 'fixture.ts'),
    ).toThrow(/NEVER_DEFINED/);
  });
});

describe('extractRegisteredNames resolves both spellings a registerPersistedStore() call uses here', () => {
  test('an inline string literal', () => {
    expect(
      extractRegisteredNames(
        `registerPersistedStore('literal-key', () => resetPersistedStore(useFooStore));`,
        'fixture.ts',
      ),
    ).toEqual(['literal-key']);
  });

  test('a module-level const reference', () => {
    const source =
      `const STORAGE_KEY = 'const-key';\n` +
      `registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useFooStore));`;
    expect(extractRegisteredNames(source, 'fixture.ts')).toEqual(['const-key']);
  });

  test('a file with no registerPersistedStore() call yields no names', () => {
    expect(extractRegisteredNames(`export const useFoo = create(() => ({}));`, 'fixture.ts')).toEqual(
      [],
    );
  });
});

describe('the coverage predicate genuinely fails closed — mutation proof', () => {
  // Pins the exact failure mode the brief's "FAIL when one is neither
  // covered" requirement describes, using a name no real store will ever
  // have — proof the check above can actually go red, not only that it
  // happens to be green today.
  test('a name matching no prefix and absent from KEEP is reported as NOT covered', () => {
    const name = 'totally-unprefixed-store-key';
    expect(isAppOwnedStorageKey(name)).toBe(false);
    expect(isKeptStorageKey(name)).toBe(false);
    expect(isAppOwnedStorageKey(name) || isKeptStorageKey(name)).toBe(false);
  });

  test('a name that matches a prefix but is not on KEEP is still covered (swept)', () => {
    expect(isAppOwnedStorageKey('kortix-not-actually-a-real-store')).toBe(true);
    expect(isKeptStorageKey('kortix-not-actually-a-real-store')).toBe(false);
  });

  test('a KEEP_STORAGE_KEYS entry is covered even though it matches no prefix logic on its own', () => {
    expect(isKeptStorageKey('kortix-sound-preferences')).toBe(true);
  });
});

describe('every SWEPT persisted store also registers its own in-memory reset', () => {
  // The disk sweep alone is not enough: `resetClientState()`'s own header
  // explains why — a component still subscribed to a persisted store can
  // re-persist the very key the sweep just deleted unless that store's
  // in-memory state is reset FIRST. Each store does that via its OWN
  // `registerPersistedStore(...)` call (see `persisted-store-registry.ts`),
  // checked here against that SAME file's `persist()` name — so a future
  // store cannot opt out of the in-memory half of the sweep either, and a
  // registration under the WRONG name (a copy-paste from another store) is
  // caught too.
  const discovered = discoverPersistedStores();

  for (const store of discovered) {
    const isKeptStore = store.names.every((name) => isKeptStorageKey(name));
    // Handled by a named, literal, SYNCHRONOUS call in `resetClientState()`
    // itself — the sign-out source tripwire (`sign-out-navigation.test.ts`)
    // pins that exact line, so it deliberately does not use the registry.
    if (store.hookName === 'useCurrentAccountStore') continue;

    if (isKeptStore) {
      // KEEP-listed stores (theme, sound, notification permission) must NOT
      // register — the disk KEEP and the in-memory exclusion are two
      // independent lists, and a store accidentally registered on BOTH
      // (matching `KEEP_STORAGE_KEYS` yet still resetting in memory) would
      // silently wipe a device-scoped preference on every sign-out, exactly
      // the regression `reset-client-state.test.ts`'s "a device-scoped KEPT
      // preference is NOT reset" behavioral test catches from the other side.
      test(`${store.file} is KEPT and correctly does NOT register itself`, () => {
        expect(extractRegisteredNames(store.source, store.file)).toEqual([]);
      });
      continue;
    }

    test(`${store.file} registers itself for every one of its persist() names`, () => {
      const registered = extractRegisteredNames(store.source, store.file);
      for (const name of store.names) {
        expect(registered).toContain(name);
      }
    });
  }
});
