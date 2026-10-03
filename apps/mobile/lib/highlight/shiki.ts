/**
 * Syntax highlighting for every code surface in apps/mobile.
 *
 * Same engine and palette as web (`apps/web/src/components/markdown/code/
 * shiki-highlighter.ts`): Shiki with `min-light` / `min-dark`. Two differences,
 * both forced by the platform:
 *
 * 1. **Regex engine.** Web runs Oniguruma compiled to WebAssembly. Hermes has
 *    no WebAssembly, so this uses Shiki's JavaScript engine, which rewrites
 *    each Oniguruma pattern into a native `RegExp`. `target: 'ES2018'` keeps
 *    the output off the `v` flag, which Hermes rejects ("Invalid RegExp:
 *    Invalid flags"). The scanner still needs the `d` flag (`match.indices`);
 *    Hermes supports it. Hermes also drops named groups from `matchAll`,
 *    which the pattern translator depends on; `match-all-groups.ts` repairs
 *    that before the engine starts. All three facts were measured on the
 *    Hermes VM the app ships: `scripts/hermes-highlight-check/run.sh`.
 *
 * 2. **Output.** React Native has no DOM, so the API returns tokens
 *    (`CodeLine[]`: lines of `{ content, color }`) instead of HTML. Font
 *    style and weight are dropped, as web's transformer does, so highlighted
 *    code is exactly as wide as plain code.
 *
 * Grammars load lazily, one per language, on the first block that needs it.
 * Metro bundles every `import()` below into the main bundle, but a grammar's
 * module (a large JSON string) is not evaluated until that language appears.
 */
import type {
  GrammarState,
  HighlighterCore,
  LanguageRegistration,
  ThemedToken,
  ThemeRegistration,
} from 'shiki/core';

import { installMatchAllGroupsFix } from './match-all-groups';
import {
  CODE_THEME_FOREGROUND,
  codeThemeFor,
  HIGHLIGHT_LANGS,
  isHighlightLang,
  normalizeLanguage,
  PLAIN_LANGS,
  type CodeScheme,
  type HighlightLang,
} from '@/lib/code-theme';

export type { CodeScheme } from '@/lib/code-theme';

export interface CodeToken {
  content: string;
  color: string;
}

export type CodeLine = CodeToken[];

type Loaded<T> = Promise<{ default: T }>;
type GrammarModule = Loaded<LanguageRegistration[]>;

/**
 * One loader per bundled grammar. Metro needs each `import()` to be a string
 * literal, so this cannot be generated from `HIGHLIGHT_LANGS`; the test pins
 * that the two lists match.
 */
export const LANGUAGE_LOADERS: Record<HighlightLang, () => GrammarModule> = {
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  terraform: () => import('shiki/langs/terraform.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  mermaid: () => import('shiki/langs/mermaid.mjs'),
};

/**
 * Code longer than this renders plain. Web clamps at 50,000 characters on
 * Oniguruma; the JavaScript engine on Hermes is slower and runs on the JS
 * thread, so the ceiling is lower. `scripts/hermes-highlight-check/run.sh`
 * prints the measured Hermes cost of a block just under this ceiling.
 */
export const MAX_HIGHLIGHT_LENGTH = 20_000;

/** A single line longer than this is left unhighlighted (minified code). */
const MAX_LINE_LENGTH = 2_000;

const CACHE_MAX = 64;

export interface HighlighterOptions {
  /**
   * Skip patterns the JavaScript engine cannot translate instead of throwing.
   * The app runs forgiving so one bad pattern degrades one scope, never the
   * block; the test runs strict so an untranslatable pattern fails loudly.
   */
  forgiving?: boolean;
}

let highlighter: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighterOptions: HighlighterOptions = { forgiving: true };
const loadedLangs = new Set<HighlightLang>();
const failedLangs = new Set<HighlightLang>();
const langPromises = new Map<HighlightLang, Promise<boolean>>();
const tokenCache = new Map<string, CodeLine[]>();

/** Create (once) the highlighter core with both themes and no grammars. */
export function ensureHighlighter(options?: HighlighterOptions): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  if (options) highlighterOptions = options;
  highlighterPromise = (async () => {
    // Before the engine compiles a single grammar: see match-all-groups.ts.
    installMatchAllGroupsFix();
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/min-light.mjs') as Loaded<ThemeRegistration>,
        import('shiki/themes/min-dark.mjs') as Loaded<ThemeRegistration>,
      ]);
    const core = await createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      engine: createJavaScriptRegexEngine({
        target: 'ES2018',
        forgiving: highlighterOptions.forgiving ?? true,
      }),
    });
    highlighter = core;
    return core;
  })();
  highlighterPromise.catch(() => {
    // Let a later call retry instead of caching the rejection forever.
    highlighterPromise = null;
  });
  return highlighterPromise;
}

/**
 * Load the grammar for `language` (a raw fence hint). Resolves `true` when
 * tokens for it can be produced synchronously, `false` for a language that is
 * not bundled or whose grammar failed to load.
 */
export function ensureLanguage(language: string): Promise<boolean> {
  const lang = normalizeLanguage(language);
  if (PLAIN_LANGS.has(lang)) return Promise.resolve(true);
  if (!isHighlightLang(lang) || failedLangs.has(lang)) return Promise.resolve(false);
  if (loadedLangs.has(lang) && highlighter) return Promise.resolve(true);
  const pending = langPromises.get(lang);
  if (pending) return pending;

  const promise = ensureHighlighter()
    .then(async (core) => {
      const grammar = await LANGUAGE_LOADERS[lang]();
      await core.loadLanguage(grammar.default);
      loadedLangs.add(lang);
      return true;
    })
    .catch(() => {
      failedLangs.add(lang);
      return false;
    })
    .finally(() => {
      langPromises.delete(lang);
    });
  langPromises.set(lang, promise);
  return promise;
}

/** Plain lines in the theme's base colour. */
export function plainTokens(code: string, scheme: CodeScheme): CodeLine[] {
  const color = CODE_THEME_FOREGROUND[scheme];
  return code.split('\n').map((line) => [{ content: line, color }]);
}

/**
 * Can `language` never be highlighted? True for plain ids, unbundled
 * languages, grammars that failed to load, and code over the length ceiling.
 * Such blocks render `plainTokens` without waiting for anything.
 */
export function isPlainOnly(code: string, language: string): boolean {
  const lang = normalizeLanguage(language);
  if (PLAIN_LANGS.has(lang)) return true;
  if (!isHighlightLang(lang) || failedLangs.has(lang)) return true;
  return code.length > MAX_HIGHLIGHT_LENGTH;
}

// `lang` and `scheme` never contain ':', and the code goes last, so the key is unambiguous.
function cacheKey(code: string, lang: string, scheme: CodeScheme) {
  return `${scheme}:${lang}:${code}`;
}

function readCache(key: string): CodeLine[] | undefined {
  const cached = tokenCache.get(key);
  if (cached) {
    // Refresh recency: Map iteration order is insertion order.
    tokenCache.delete(key);
    tokenCache.set(key, cached);
  }
  return cached;
}

function writeCache(key: string, lines: CodeLine[]) {
  tokenCache.set(key, lines);
  if (tokenCache.size > CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
}

/** Shiki tokens → merged `{ content, color }` runs. */
function toCodeLines(raw: ThemedToken[][], fallback: string): CodeLine[] {
  return raw.map((line) => {
    const merged: CodeLine = [];
    for (const token of line) {
      const color = token.color ?? fallback;
      const last = merged[merged.length - 1];
      if (last && last.color === color) last.content += token.content;
      else merged.push({ content: token.content, color });
    }
    return merged;
  });
}

/**
 * Tokens for `code` from the cache only — never tokenizes. `null` on a miss.
 * Plain-only input returns plain lines.
 */
export function peekTokens(code: string, language: string, scheme: CodeScheme): CodeLine[] | null {
  const lang = normalizeLanguage(language);
  if (isPlainOnly(code, lang)) return plainTokens(code, scheme);
  return readCache(cacheKey(code, lang, scheme)) ?? null;
}

/**
 * Tokens for `code`, synchronously, from the cache or tokenized now.
 *
 * Returns `null` only while the grammar is still loading — call
 * `ensureLanguage` and retry. Plain-only input (see `isPlainOnly`) returns
 * plain lines at once. Results are memoized by (code, language, scheme).
 *
 * Tokenizing runs on the JS thread: ~1.2 s for 20,000 characters of
 * TypeScript on Hermes (M-series Mac; a phone is slower). UI code should use
 * `highlightToTokensAsync` for anything over `SYNC_HIGHLIGHT_LENGTH`.
 */
export function highlightToTokens(
  code: string,
  language: string,
  scheme: CodeScheme,
): CodeLine[] | null {
  const lang = normalizeLanguage(language);
  if (isPlainOnly(code, lang)) return plainTokens(code, scheme);
  const key = cacheKey(code, lang, scheme);
  const cached = readCache(key);
  if (cached) return cached;
  if (!highlighter || !loadedLangs.has(lang as HighlightLang)) return null;

  let lines: CodeLine[];
  try {
    const raw = highlighter.codeToTokensBase(code, {
      lang,
      theme: codeThemeFor(scheme),
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
    });
    lines = toCodeLines(raw, CODE_THEME_FOREGROUND[scheme]);
  } catch {
    lines = plainTokens(code, scheme);
  }
  writeCache(key, lines);
  return lines;
}

/**
 * Code at or under this length may tokenize synchronously during render
 * (a few milliseconds on Hermes). Longer code goes through
 * `highlightToTokensAsync`, which never holds the JS thread for a whole block.
 */
export const SYNC_HIGHLIGHT_LENGTH = 2_000;

/** Longest stretch one async slice may hold the JS thread, in milliseconds. */
const SLICE_BUDGET_MS = 8;

/** Lines tokenized between budget checks. */
const LINES_PER_STEP = 8;

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const pendingAsync = new Map<string, Promise<CodeLine[]>>();

/**
 * Tokens for `code` without blocking: loads the grammar, then tokenizes in
 * slices of at most ~8 ms, carrying Shiki's grammar state across slices so the
 * result is identical to a single pass. Concurrent calls for the same input
 * share one run; the result lands in the same cache `highlightToTokens` reads.
 */
export function highlightToTokensAsync(
  code: string,
  language: string,
  scheme: CodeScheme,
): Promise<CodeLine[]> {
  const lang = normalizeLanguage(language);
  if (isPlainOnly(code, lang)) return Promise.resolve(plainTokens(code, scheme));
  const key = cacheKey(code, lang, scheme);
  const cached = readCache(key);
  if (cached) return Promise.resolve(cached);
  const inflight = pendingAsync.get(key);
  if (inflight) return inflight;

  const run = (async (): Promise<CodeLine[]> => {
    const ready = await ensureLanguage(lang);
    const core = highlighter;
    if (!ready || !core || isPlainOnly(code, lang)) return plainTokens(code, scheme);

    const theme = codeThemeFor(scheme);
    const fallback = CODE_THEME_FOREGROUND[scheme];
    const source = code.split('\n');
    const lines: CodeLine[] = [];
    let state: GrammarState | undefined;
    let index = 0;
    try {
      while (index < source.length) {
        const sliceStart = Date.now();
        do {
          const end = Math.min(source.length, index + LINES_PER_STEP);
          const raw = core.codeToTokensBase(source.slice(index, end).join('\n'), {
            lang,
            theme,
            grammarState: state,
            tokenizeMaxLineLength: MAX_LINE_LENGTH,
          });
          state = core.getLastGrammarState(raw);
          lines.push(...toCodeLines(raw, fallback));
          index = end;
        } while (index < source.length && Date.now() - sliceStart < SLICE_BUDGET_MS);
        if (index < source.length) await yieldToEventLoop();
      }
    } catch {
      return plainTokens(code, scheme);
    }
    writeCache(key, lines);
    return lines;
  })().finally(() => {
    pendingAsync.delete(key);
  });
  pendingAsync.set(key, run);
  return run;
}

/** Test-only access to module state. */
export const __testing = {
  HIGHLIGHT_LANGS,
  tokenCache,
  loadedLangs,
  failedLangs,
  getHighlighter: () => highlighter,
};
