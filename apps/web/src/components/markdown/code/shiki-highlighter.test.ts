import { afterEach, describe, expect, test } from 'bun:test';

import {
  __testing,
  clampCode,
  highlightAsync,
  highlightSync,
  SHIKI_THEME_DARK,
  SHIKI_THEME_LIGHT,
  shikiKey,
} from './shiki-highlighter';

const MAX = 50_000;
const MARKER = '\n// ... (truncated for highlighting)';

const { shikiCache, SHIKI_CACHE_MAX, cacheHtml, loadedLangs } = __testing;

// The cache is module-level and shared with every other suite in the process.
afterEach(() => {
  shikiCache.clear();
});

describe('clampCode', () => {
  test('passes code under the ceiling through byte-identical', () => {
    const code = 'const a = 1;\nexport default a;\n';
    expect(clampCode(code)).toBe(code);

    const long = 'x'.repeat(MAX - 1);
    expect(clampCode(long)).toBe(long);
  });

  test('exactly 50,000 characters is not truncated', () => {
    const code = 'x'.repeat(MAX);

    expect(clampCode(code)).toBe(code);
    expect(clampCode(code)).not.toContain(MARKER);
  });

  test('50,001 characters is truncated and carries the marker', () => {
    const clamped = clampCode('x'.repeat(MAX + 1));

    expect(clamped.endsWith(MARKER)).toBe(true);
    expect(clamped.length).toBe(MAX + MARKER.length);
  });

  test('the overflowing tail is dropped, not merely annotated', () => {
    const clamped = clampCode('x'.repeat(MAX) + 'DROP_ME');

    expect(clamped).toBe('x'.repeat(MAX) + MARKER);
    expect(clamped).not.toContain('DROP_ME');
  });

  test('unbounded skips the clamp regardless of length', () => {
    const huge = 'x'.repeat(MAX * 5) + 'KEEP_ME';

    expect(clampCode(huge, true)).toBe(huge);
    expect(clampCode(huge, true)).toContain('KEEP_ME');
    expect(clampCode(huge, true)).not.toContain(MARKER);
  });
});

describe('shikiKey', () => {
  test('identical code, language and theme produce an identical key', () => {
    expect(shikiKey('const a = 1;', 'typescript', SHIKI_THEME_DARK)).toBe(
      shikiKey('const a = 1;', 'typescript', SHIKI_THEME_DARK),
    );
  });

  test('the key moves with the language and with the theme', () => {
    const code = 'const a = 1;';

    expect(shikiKey(code, 'typescript', SHIKI_THEME_DARK)).not.toBe(
      shikiKey(code, 'javascript', SHIKI_THEME_DARK),
    );

    // Guards the theme half against the two constants ever being set equal,
    // which would make the assertion below vacuous rather than false.
    expect(SHIKI_THEME_DARK).not.toBe(SHIKI_THEME_LIGHT);
    expect(shikiKey(code, 'typescript', SHIKI_THEME_DARK)).not.toBe(
      shikiKey(code, 'typescript', SHIKI_THEME_LIGHT),
    );
  });

  test('two long strings sharing a head and tail but differing in length get different keys', () => {
    const head = 'a'.repeat(100);
    const tail = 'b'.repeat(100);

    expect(shikiKey(head + 'MIDDLE' + tail, 'typescript', SHIKI_THEME_DARK)).not.toBe(
      shikiKey(head + 'MIDDLE!' + tail, 'typescript', SHIKI_THEME_DARK),
    );
  });

  test('BUG: two different long strings of the same length collide on one key', () => {
    // Past 200 characters the signature is head(100) + tail(100) + length, so
    // any edit that stays inside the middle and keeps the length produces the
    // same key as the text it replaced. Documented, not asserted away.
    const head = 'a'.repeat(100);
    const tail = 'b'.repeat(100);
    const plus = `${head}const total = subtotal + tax;${tail}`;
    const minus = `${head}const total = subtotal - tax;${tail}`;

    expect(plus).not.toBe(minus);
    expect(plus.length).toBe(minus.length);
    expect(shikiKey(plus, 'typescript', SHIKI_THEME_DARK)).toBe(
      shikiKey(minus, 'typescript', SHIKI_THEME_DARK),
    );
  });

  test('BUG: the collision serves one snippet the other snippet’s highlighted HTML', () => {
    // What the key collision costs a reader: highlightSync answers from the
    // cache before it looks at the code it was handed.
    const head = 'a'.repeat(100);
    const tail = 'b'.repeat(100);
    const plus = `${head}const total = subtotal + tax;${tail}`;
    const minus = `${head}const total = subtotal - tax;${tail}`;

    cacheHtml(shikiKey(plus, 'typescript', SHIKI_THEME_DARK), '<pre>PLUS</pre>');

    expect(highlightSync(minus, 'typescript', SHIKI_THEME_DARK)).toBe('<pre>PLUS</pre>');
  });
});

describe('the LRU cache', () => {
  test('fills to the maximum without evicting anything', () => {
    shikiCache.clear();
    for (let i = 0; i < SHIKI_CACHE_MAX; i++) cacheHtml(`k${i}`, `<pre>${i}</pre>`);

    expect(shikiCache.size).toBe(SHIKI_CACHE_MAX);
    expect(shikiCache.has('k0')).toBe(true);
    expect(shikiCache.has(`k${SHIKI_CACHE_MAX - 1}`)).toBe(true);
  });

  test('one entry past the maximum drops the oldest and keeps the newest', () => {
    shikiCache.clear();
    for (let i = 0; i < SHIKI_CACHE_MAX; i++) cacheHtml(`k${i}`, `<pre>${i}</pre>`);

    cacheHtml('newest', '<pre>newest</pre>');

    expect(shikiCache.size).toBe(SHIKI_CACHE_MAX);
    expect(shikiCache.has('k0')).toBe(false);
    expect(shikiCache.has('k1')).toBe(true);
    expect(shikiCache.get('newest')).toBe('<pre>newest</pre>');
  });
});

describe('highlightSync', () => {
  test('returns null before the highlighter has initialised', async () => {
    // A query-busted specifier gets its own module record, so `highlighterReady`
    // starts null again. Reading it back through the file-scope import instead
    // would answer for whichever suite ran first in this process — by the time a
    // second test file loads, the singleton has usually settled.
    const cold: typeof import('./shiki-highlighter') = await import(
      `./shiki-highlighter?cold=${Date.now()}`
    );

    // The module body only kicks the highlighter off; it is assigned a tick
    // later, so the first synchronous call still sees the uninitialised state.
    expect(cold.highlightSync('const first = 1;', 'typescript', SHIKI_THEME_DARK)).toBeNull();
  });

  test('returns null for a language the highlighter never loaded', () => {
    // `zig` is intentionally outside PRELOAD_LANGS — rare enough to lazy-load.
    expect(loadedLangs.has('zig')).toBe(false);

    expect(highlightSync('const x = 1;', 'zig', SHIKI_THEME_DARK)).toBeNull();
  });

  test('an initialised highlighter answers synchronously — until the grammar leaves loadedLangs', async () => {
    // Awaiting the async path is the only honest route to the initialised
    // state: it resolves the same singleton promise highlightSync reads. It
    // also makes the two nulls above meaningful rather than vacuous.
    expect(await highlightAsync('const warm = 1;', 'typescript', SHIKI_THEME_DARK)).toContain(
      '<pre',
    );
    expect(highlightSync('const hot = 2;', 'typescript', SHIKI_THEME_DARK)).toContain('<pre');

    loadedLangs.delete('typescript');
    try {
      expect(highlightSync('const cold = 3;', 'typescript', SHIKI_THEME_DARK)).toBeNull();
    } finally {
      loadedLangs.add('typescript');
    }
  });
});

describe('the single palette', () => {
  test('both halves are built into the singleton, so neither needs an async round trip', async () => {
    // Awaiting the async path is the only honest route to the initialised
    // state: it resolves the same singleton promise highlightSync reads.
    expect(await highlightAsync('const warm = 1;', 'typescript', SHIKI_THEME_DARK)).toContain(
      '<pre',
    );

    // Both themes ship in the singleton's `themes: []`, so neither half ever
    // lazy-loads and both answer synchronously. This is what let the theme
    // loader be deleted.
    expect(highlightSync('const d = 1;', 'typescript', SHIKI_THEME_DARK)).toContain('<pre');
    expect(highlightSync('const l = 1;', 'typescript', SHIKI_THEME_LIGHT)).toContain('<pre');
  });

  test('the two halves do not share a cache entry', () => {
    const code = 'const a = 1;';

    expect(shikiKey(code, 'typescript', SHIKI_THEME_DARK)).not.toBe(
      shikiKey(code, 'typescript', SHIKI_THEME_LIGHT),
    );
  });
});

describe('the lock', () => {
  test('a foreign theme does not type-check', () => {
    // @ts-expect-error - 'github-dark' is not in CodeThemeName. This directive
    // is the regression test: if the parameter ever widens back to `string`,
    // the line stops erroring, the directive goes unused, and tsc fails.
    expect(highlightSync('const a = 1;', 'typescript', 'github-dark')).toBeNull();
  });
});
