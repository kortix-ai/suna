import { beforeAll, describe, expect, test } from 'bun:test';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import minDark from 'shiki/themes/min-dark.mjs';
import minLight from 'shiki/themes/min-light.mjs';

import {
  CODE_THEME_FOREGROUND,
  HIGHLIGHT_LANGS,
  LANGUAGE_ALIASES,
  languageLabel,
  normalizeLanguage,
  SHIKI_THEME_DARK,
  SHIKI_THEME_LIGHT,
} from '@/lib/code-theme';

import { HIGHLIGHT_SAMPLES } from './samples';
import {
  __testing,
  ensureHighlighter,
  ensureLanguage,
  highlightToTokens,
  highlightToTokensAsync,
  isPlainOnly,
  LANGUAGE_LOADERS,
  MAX_HIGHLIGHT_LENGTH,
  plainTokens,
  type CodeLine,
} from './shiki';

/**
 * Collapse tokens to one string per colour run, so two tokenizations compare
 * equal when they paint the same characters the same colour, however each
 * engine happened to split the runs.
 */
function paint(lines: CodeLine[]): string[] {
  return lines.map((line) => {
    const out: string[] = [];
    let color = '';
    let run = '';
    for (const { content, color: c } of line) {
      for (const ch of content) {
        const next = c.toLowerCase();
        if (next !== color && run) {
          out.push(`${color}:${run}`);
          run = '';
        }
        color = next;
        run += ch;
      }
    }
    if (run) out.push(`${color}:${run}`);
    return out.join('|');
  });
}

describe('language table', () => {
  test('every bundled grammar has exactly one loader', () => {
    expect(Object.keys(LANGUAGE_LOADERS).sort()).toEqual([...HIGHLIGHT_LANGS].sort());
  });

  test('every alias lands on a bundled grammar or plain text', () => {
    for (const [alias, target] of Object.entries(LANGUAGE_ALIASES)) {
      const ok = (HIGHLIGHT_LANGS as readonly string[]).includes(target) || target === 'text';
      expect({ alias, target, ok }).toEqual({ alias, target, ok: true });
    }
  });

  test('normalizeLanguage and languageLabel match web', () => {
    expect(normalizeLanguage('TS')).toBe('typescript');
    expect(normalizeLanguage('golang')).toBe('go');
    expect(normalizeLanguage('sh')).toBe('bash');
    expect(languageLabel('')).toBe('text');
    expect(languageLabel('psql')).toBe('psql');
    expect(languageLabel('c++')).toBe('c++');
    expect(languageLabel('js')).toBe('javascript');
  });
});

describe('highlighter (JavaScript regex engine, strict)', () => {
  let oniguruma: HighlighterCore;

  beforeAll(async () => {
    // Strict: an Oniguruma pattern the JS engine cannot translate throws here
    // instead of silently skipping a scope.
    await ensureHighlighter({ forgiving: false });
    // Reference: the WebAssembly Oniguruma engine web runs.
    oniguruma = await createHighlighterCore({
      themes: [minLight, minDark],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
  });

  test('a grammar that is still loading returns null, then tokens', async () => {
    expect(highlightToTokens('fn main() {}', 'rust', 'light')).toBeNull();
    expect(await ensureLanguage('rs')).toBe(true);
    expect(highlightToTokens('fn main() {}', 'rust', 'light')).not.toBeNull();
  });

  test('theme base colours match the Shiki theme JSON', () => {
    const core = __testing.getHighlighter()!;
    expect(core.getTheme(SHIKI_THEME_LIGHT).fg.toLowerCase()).toBe(CODE_THEME_FOREGROUND.light);
    expect(core.getTheme(SHIKI_THEME_DARK).fg.toLowerCase()).toBe(CODE_THEME_FOREGROUND.dark);
  });

  test('a TypeScript keyword is #D32F2F on light and #F97583 on dark', async () => {
    await ensureLanguage('ts');
    const light = highlightToTokens('const a = 1;', 'ts', 'light')!;
    const dark = highlightToTokens('const a = 1;', 'ts', 'dark')!;
    expect(light[0][0]).toEqual({ content: 'const', color: '#D32F2F' });
    expect(dark[0][0]).toEqual({ content: 'const', color: '#F97583' });
    expect(minLight.tokenColors?.some((r) => r.settings.foreground === '#D32F2F')).toBe(true);
    expect(minDark.tokenColors?.some((r) => r.settings.foreground === '#f97583')).toBe(true);
  });

  /**
   * Grammars the min themes paint in one colour on BOTH engines: min-light and
   * min-dark have no rule for diff's `markup.inserted` / `markup.deleted`
   * scopes, so web shows diffs uncoloured too.
   */
  const MONOCHROME_UNDER_MIN_THEMES = new Set(['diff']);

  /**
   * Lines where the JavaScript engine provably differs from Oniguruma. Each
   * entry is asserted to STILL differ, so a Shiki upgrade that fixes it fails
   * this test and the entry gets deleted.
   *
   * ini: `(^[\t ]+)?(?=;)` … `end: (?!\G)` — the engine's `\G` emulation ends
   * the zero-width begin at once, so a `;` comment AFTER a value on the same
   * line stays base colour. Comments at the start of a line still colour.
   */
  const KNOWN_ENGINE_DIFFERENCES: Record<string, number[]> = { ini: [2] };

  for (const lang of HIGHLIGHT_LANGS) {
    test(`${lang}: compiles, colours, and matches Oniguruma in both themes`, async () => {
      const sample = HIGHLIGHT_SAMPLES[lang];
      expect(await ensureLanguage(lang)).toBe(true);
      await oniguruma.loadLanguage((await LANGUAGE_LOADERS[lang]()).default);

      for (const scheme of ['light', 'dark'] as const) {
        const tokens = highlightToTokens(sample, lang, scheme);
        expect(tokens).not.toBeNull();
        const colors = new Set(tokens!.flat().map((t) => t.color.toLowerCase()));
        // Highlighted means more than the base colour.
        if (!MONOCHROME_UNDER_MIN_THEMES.has(lang)) expect(colors.size).toBeGreaterThan(1);
        expect(tokens!.map((l) => l.map((t) => t.content).join(''))).toEqual(sample.split('\n'));

        const reference = oniguruma
          .codeToTokensBase(sample, {
            lang,
            theme: scheme === 'dark' ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT,
          })
          .map((line) =>
            line.map((t) => ({ content: t.content, color: t.color ?? CODE_THEME_FOREGROUND[scheme] })),
          );
        const ours = paint(tokens!);
        const theirs = paint(reference);
        const differing = KNOWN_ENGINE_DIFFERENCES[lang] ?? [];
        for (const line of differing) expect(ours[line]).not.toEqual(theirs[line]);
        const keep = (_: string, i: number) => !differing.includes(i);
        expect(ours.filter(keep)).toEqual(theirs.filter(keep));
      }
    });
  }
});

describe('async sliced tokenization', () => {
  // A block comment and a template literal that span many lines, so slice
  // boundaries (every 8 lines) fall inside open scopes.
  const longTs = Array.from({ length: 60 }, (_, i) =>
    i % 20 === 0
      ? `/* opens a comment\n${' * still inside\n'.repeat(19)} */ const x = \`multi\n${'line\n'.repeat(10)}\`;`
      : `export function f${i}(a: number): string { return "v" + a; } // ${i}`,
  ).join('\n');

  test('produces exactly the tokens of a single synchronous pass', async () => {
    await ensureLanguage('typescript');
    const sliced = await highlightToTokensAsync(longTs, 'typescript', 'dark');
    __testing.tokenCache.clear();
    const single = highlightToTokens(longTs, 'typescript', 'dark');
    expect(paint(sliced)).toEqual(paint(single!));
  });

  test('shares one run between concurrent callers and fills the sync cache', async () => {
    __testing.tokenCache.clear();
    const a = highlightToTokensAsync(longTs, 'ts', 'light');
    const b = highlightToTokensAsync(longTs, 'typescript', 'light');
    expect(a).toBe(b);
    const tokens = await a;
    expect(highlightToTokens(longTs, 'ts', 'light')).toBe(tokens);
  });

  test('an unbundled language resolves to plain lines', async () => {
    expect(await highlightToTokensAsync('a\nb', 'cobol', 'light')).toEqual(plainTokens('a\nb', 'light'));
  });
});

describe('plain paths and memoization', () => {
  test('plain ids, unknown languages and oversized code render plain at once', () => {
    expect(isPlainOnly('x', '')).toBe(true);
    expect(isPlainOnly('x', 'txt')).toBe(true);
    expect(isPlainOnly('x', 'brainfuck')).toBe(true);
    expect(isPlainOnly('x'.repeat(MAX_HIGHLIGHT_LENGTH + 1), 'ts')).toBe(true);
    expect(highlightToTokens('a\nb', 'cobol', 'dark')).toEqual(plainTokens('a\nb', 'dark'));
    expect(plainTokens('a\nb', 'light')).toEqual([
      [{ content: 'a', color: CODE_THEME_FOREGROUND.light }],
      [{ content: 'b', color: CODE_THEME_FOREGROUND.light }],
    ]);
  });

  test('the same (code, language, scheme) returns the memoized array', async () => {
    await ensureLanguage('python');
    const first = highlightToTokens('x = 1', 'py', 'light');
    expect(highlightToTokens('x = 1', 'python', 'light')).toBe(first);
    expect(highlightToTokens('x = 1', 'python', 'dark')).not.toBe(first);
  });

  test('the token cache is bounded', async () => {
    await ensureLanguage('json');
    for (let i = 0; i < 100; i++) highlightToTokens(`{"n": ${i}}`, 'json', 'light');
    expect(__testing.tokenCache.size).toBeLessThanOrEqual(64);
  });
});
