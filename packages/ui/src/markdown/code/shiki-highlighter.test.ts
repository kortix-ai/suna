import { afterEach, describe, expect, test } from 'bun:test';

import {
  __testing,
  PRELOAD_LANGS,
  highlightAsync,
  highlightSync,
  SHIKI_THEME_DARK,
  SHIKI_THEME_LIGHT,
  shikiKey,
} from './shiki-highlighter';

const MAX = 50_000;

const { shikiCache, SHIKI_CACHE_MAX, cacheHtml, loadedLangs } = __testing;

// The cache is module-level and shared with every other suite in the process.
afterEach(() => {
  shikiCache.clear();
});

describe('the length limit', () => {
  test('exactly 50,000 characters still highlights', async () => {
    expect(await highlightAsync('x'.repeat(MAX), 'text', SHIKI_THEME_DARK)).toContain('<pre');
  });

  test('50,001 characters is not highlighted at all, sync or async', async () => {
    const code = 'x'.repeat(MAX + 1);
    // Warm first, so the sync null proves the limit rather than a cold highlighter.
    await highlightAsync('warm', 'text', SHIKI_THEME_DARK);

    expect(await highlightAsync(code, 'text', SHIKI_THEME_DARK)).toBeNull();
    expect(highlightSync(code, 'text', SHIKI_THEME_DARK)).toBeNull();
    expect(shikiCache.size).toBe(1);
  });

  test('unbounded highlights past the limit, through the last line', async () => {
    const code = 'x'.repeat(MAX + 1) + '\nLAST_LINE';

    expect(await highlightAsync(code, 'text', SHIKI_THEME_DARK, { unbounded: true })).toContain(
      'LAST_LINE',
    );
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

  test('two different long strings of the same length get different keys', () => {
    // The key used to be head(100) + tail(100) + length, so an edit inside the
    // middle that kept the length collided with the text it replaced. The key
    // now hashes the whole string.
    const head = 'a'.repeat(100);
    const tail = 'b'.repeat(100);
    const plus = `${head}const total = subtotal + tax;${tail}`;
    const minus = `${head}const total = subtotal - tax;${tail}`;

    expect(plus).not.toBe(minus);
    expect(plus.length).toBe(minus.length);
    expect(shikiKey(plus, 'typescript', SHIKI_THEME_DARK)).not.toBe(
      shikiKey(minus, 'typescript', SHIKI_THEME_DARK),
    );
  });

  test('a cached snippet is never served for a different snippet of the same length', () => {
    const head = 'a'.repeat(100);
    const tail = 'b'.repeat(100);
    const plus = `${head}const total = subtotal + tax;${tail}`;
    const minus = `${head}const total = subtotal - tax;${tail}`;

    cacheHtml(shikiKey(plus, 'typescript', SHIKI_THEME_DARK), '<pre>PLUS</pre>');

    expect(highlightSync(minus, 'typescript', SHIKI_THEME_DARK)).not.toBe('<pre>PLUS</pre>');
  });
});

describe('rendering mode isolation', () => {
  test('omitted and false modes both skip oversized code, true highlights it', async () => {
    const code = '// normalization\n'.repeat(3000) + '// NORMALIZED_TAIL';
    const [omitted, bounded, full] = await Promise.all([
      highlightAsync(code, 'javascript', SHIKI_THEME_DARK),
      highlightAsync(code, 'javascript', SHIKI_THEME_DARK, { unbounded: false }),
      highlightAsync(code, 'javascript', SHIKI_THEME_DARK, { unbounded: true }),
    ]);
    expect(omitted).toBeNull();
    expect(bounded).toBeNull();
    expect(full?.includes('NORMALIZED_TAIL')).toBe(true);
  });

  for (const firstUnbounded of [false, true]) {
    test(`cached HTML respects mode, starting unbounded=${firstUnbounded}`, async () => {
      const code = '// padding\n'.repeat(5001) + '// UNIQUE_TAIL';
      for (const unbounded of [firstUnbounded, !firstUnbounded, firstUnbounded]) {
        const html = await highlightAsync(code, 'javascript', SHIKI_THEME_DARK, { unbounded });
        if (unbounded) expect(html).toContain('UNIQUE_TAIL');
        else expect(html).toBeNull();
        expect(highlightSync(code, 'javascript', SHIKI_THEME_DARK, { unbounded })).toBe(html);
      }
      // Only the unbounded HTML is cached; oversized bounded code never reaches it.
      expect(shikiCache.size).toBe(1);
    });

    test(`concurrent requests respect mode, starting unbounded=${firstUnbounded}`, async () => {
      const code = '// padding\n'.repeat(5001) + '// CONCURRENT_TAIL';
      const modes = [firstUnbounded, !firstUnbounded];
      const results = await Promise.all(
        modes.map((unbounded) =>
          highlightAsync(code, 'javascript', SHIKI_THEME_LIGHT, { unbounded }),
        ),
      );
      results.forEach((html, index) => {
        if (modes[index]) expect(html).toContain('CONCURRENT_TAIL');
        else expect(html).toBeNull();
      });
    });
  }
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

// Regression for Better Stack 1604d50a (`WebAssembly is not defined`): visitors
// whose browser blocks WebAssembly must still get highlighted code, and must
// never fire an unhandled rejection. The JavaScript regex engine needs no
// WebAssembly at all.
describe('without WebAssembly', () => {
  test('a cold highlighter still highlights', async () => {
    const original = (globalThis as { WebAssembly?: unknown }).WebAssembly;
    try {
      delete (globalThis as { WebAssembly?: unknown }).WebAssembly;
      const cold: typeof import('./shiki-highlighter') = await import(
        `./shiki-highlighter?nowasm=${Date.now()}`
      );
      expect(await cold.highlightAsync('const a = 1;', 'typescript', SHIKI_THEME_DARK)).toContain(
        '<pre',
      );
    } finally {
      (globalThis as { WebAssembly?: unknown }).WebAssembly = original;
    }
  });
});

describe('on-demand grammars', () => {
  test('nothing loads before the first highlight request', async () => {
    const cold: typeof import('./shiki-highlighter') = await import(
      `./shiki-highlighter?lazy=${Date.now()}`
    );
    expect(cold.__testing.loadedLangs.size).toBe(0);
  });

  test('a grammar outside PRELOAD_LANGS loads on first use and then answers synchronously', async () => {
    expect(PRELOAD_LANGS).not.toContain('rust');
    expect(await highlightAsync('fn main() {}', 'rust', SHIKI_THEME_DARK)).toContain('<pre');
    expect(loadedLangs.has('rust')).toBe(true);
    expect(highlightSync('fn other() {}', 'rust', SHIKI_THEME_DARK)).toContain('<pre');
  });

  test('an unknown hint resolves to null (plain text), not a rejection', async () => {
    expect(await highlightAsync('x', 'not-a-language', SHIKI_THEME_DARK)).toBeNull();
  });

  test('plain-text hints highlight without a grammar', async () => {
    expect(await highlightAsync('just text', 'text', SHIKI_THEME_DARK)).toContain('just text');
  });

  test('PRELOAD_LANGS is a handful, not the old ~58', () => {
    expect(PRELOAD_LANGS.length).toBeLessThanOrEqual(10);
  });
});
