import { afterEach, describe, expect, test } from 'bun:test';
import type { Highlighter } from 'shiki';

import {
  __testing,
  clampCode,
  highlightAsync,
  highlightSync,
  MARKDOWN_THEME,
  PIERRE_THEME,
  SHIKI_THEME_DARK,
  SHIKI_THEME_LIGHT,
  shikiKey,
} from './shiki-highlighter';

const MAX = 50_000;
const MARKER = '\n// ... (truncated for highlighting)';

const {
  shikiCache,
  SHIKI_CACHE_MAX,
  cacheHtml,
  loadedLangs,
  loadedThemes,
  themeLoadPromises,
  ensureThemeLoaded,
  resolveCodeTheme,
} = __testing;

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

  test('returns null for a theme the highlighter never loaded', async () => {
    // Warm the singleton first, so the null below is about the theme and not
    // about an uninitialised highlighter — the same trick the test above uses.
    expect(await highlightAsync('const warm = 1;', 'typescript', SHIKI_THEME_DARK)).toContain(
      '<pre',
    );

    // Pierre is lazy on purpose: its TextMate JSON only reaches Shiki through
    // ensureThemeLoaded, so a synchronous first paint has nothing to key on.
    const pierreDark = resolveCodeTheme(PIERRE_THEME.dark).name;
    expect(loadedThemes.has(pierreDark)).toBe(false);

    expect(highlightSync('const x = 1;', 'typescript', PIERRE_THEME.dark)).toBeNull();
  });
});

describe('the two theme pairs', () => {
  test('resolve to different names, so one cache key cannot serve both', () => {
    const code = 'const a = 1;';
    const markdown = resolveCodeTheme(MARKDOWN_THEME.dark).name;
    const pierre = resolveCodeTheme(PIERRE_THEME.dark).name;

    // Guards the assertion below against the two pairs ever being set equal,
    // which would make it vacuous rather than false.
    expect(markdown).not.toBe(pierre);
    expect(shikiKey(code, 'typescript', markdown)).not.toBe(shikiKey(code, 'typescript', pierre));
  });

  test('a bundled name resolves to itself; a registration resolves to its own name', () => {
    expect(resolveCodeTheme(SHIKI_THEME_DARK)).toEqual({
      name: SHIKI_THEME_DARK,
      input: SHIKI_THEME_DARK,
    });

    const registration = { name: 'Pair Probe', settings: [] };
    expect(resolveCodeTheme(registration)).toEqual({ name: 'Pair Probe', input: registration });
  });

  test('the markdown pair is loaded eagerly — it is built into the singleton', () => {
    expect(loadedThemes.has(resolveCodeTheme(MARKDOWN_THEME.dark).name)).toBe(true);
    expect(loadedThemes.has(resolveCodeTheme(MARKDOWN_THEME.light).name)).toBe(true);
  });
});

describe('ensureThemeLoaded', () => {
  /** A highlighter stub whose `loadTheme` resolves only when the test says so. */
  function gatedHighlighter() {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = {
      loadTheme: () => {
        calls++;
        return gate;
      },
    } as unknown as Highlighter;
    return { h, gate, release: () => release(), calls: () => calls };
  }

  test('a theme already in loadedThemes is never handed to loadTheme again', async () => {
    const { h, calls } = gatedHighlighter();
    expect(loadedThemes.has(SHIKI_THEME_DARK)).toBe(true);

    await ensureThemeLoaded(h, SHIKI_THEME_DARK);
    await ensureThemeLoaded(h, SHIKI_THEME_DARK);

    expect(calls()).toBe(0);
  });

  test('concurrent calls for one theme share a single load, and it stays loaded after', async () => {
    const { h, release, calls } = gatedHighlighter();
    const theme = { name: 'Concurrent Probe', settings: [] };

    const first = ensureThemeLoaded(h, theme);
    const second = ensureThemeLoaded(h, theme);

    // The second caller gets the in-flight promise itself, not a second load.
    expect(second).toBe(first);
    expect(calls()).toBe(1);
    expect(themeLoadPromises.get('Concurrent Probe')).toBe(first);

    release();
    try {
      await Promise.all([first, second]);

      expect(calls()).toBe(1);
      expect(loadedThemes.has('Concurrent Probe')).toBe(true);
      // The in-flight entry is cleared, so a later failure can retry.
      expect(themeLoadPromises.has('Concurrent Probe')).toBe(false);

      // Idempotent: the fourth call short-circuits on the Set.
      await ensureThemeLoaded(h, theme);
      expect(calls()).toBe(1);
    } finally {
      loadedThemes.delete('Concurrent Probe');
    }
  });

  test('a failed load leaves the theme unloaded and retryable', async () => {
    let calls = 0;
    const h = {
      loadTheme: () => {
        calls++;
        return Promise.reject(new Error('no such theme'));
      },
    } as unknown as Highlighter;
    const theme = { name: 'Broken Probe', settings: [] };

    await ensureThemeLoaded(h, theme);

    expect(calls).toBe(1);
    expect(loadedThemes.has('Broken Probe')).toBe(false);
    expect(themeLoadPromises.has('Broken Probe')).toBe(false);

    await ensureThemeLoaded(h, theme);
    expect(calls).toBe(2);
  });
});
