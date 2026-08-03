import {
  normalizeLanguage,
  shikiWasmAvailable,
} from '@/components/markdown/unified-markdown-utils';
import { SHIKI_THEMES } from '@/lib/shiki-theme';
import { cn } from '@/lib/utils';
import {
  codeToHtml,
  getSingletonHighlighter,
  type Highlighter,
  type ShikiTransformer,
  type ThemeRegistrationAny,
} from 'shiki';

// ─── Shiki highlighting ──────────────────────────────────────────────────────
// One engine, two palettes. Markdown code uses the bundled `github-dark` /
// `github-light` pair; surfaces that sit beside a diff or the CodeMirror editor
// use the Pierre pair from `@/lib/shiki-theme`, so restyling one never touches
// the other. The palette is a parameter — see `CodeTheme` below.
export const SHIKI_THEME_DARK = 'github-dark';
export const SHIKI_THEME_LIGHT = 'github-light';

// A theme is either a bundled name (already known to Shiki) or a TextMate
// registration object that carries its own `name`.
export type CodeThemeInput = string | ThemeRegistrationAny;

/** A dark/light palette. Callers pass the pair; the component picks the half. */
export interface CodeTheme {
  dark: CodeThemeInput;
  light: CodeThemeInput;
}

/** The markdown palette. The default for every code surface. */
export const MARKDOWN_THEME: CodeTheme = { dark: SHIKI_THEME_DARK, light: SHIKI_THEME_LIGHT };

/** The Pierre palette, shared with `@pierre/diffs` and the CodeMirror theme. */
export const PIERRE_THEME: CodeTheme = {
  dark: SHIKI_THEMES.dark as ThemeRegistrationAny,
  light: SHIKI_THEMES.light as ThemeRegistrationAny,
};

// Shiki keys a loaded theme by NAME, but `loadTheme` needs the OBJECT. Every
// entry point therefore resolves an input into both halves once: the name goes
// into the cache key and the `codeToHtml` call, the input goes into `loadTheme`.
//
// A registration with no `name` cannot be keyed — Shiki has nothing to look it
// up by — so it resolves to the empty name, never enters `loadedThemes`, and
// falls through to the plain-code path instead of highlighting under a key that
// would collide with the next nameless theme.
function resolveCodeTheme(theme: CodeThemeInput): { name: string; input: CodeThemeInput } {
  if (typeof theme === 'string') return { name: theme, input: theme };
  return { name: theme.name ?? '', input: theme };
}

const SHIKI_MAX_LENGTH = 50_000;

// Pre-loaded at init; anything else lazy-loads on first use. `text` lets no-hint
// fences flow through Shiki so they pick up the same editor foreground as the rest.
// Keep this list to languages AI agents emit often — rare grammars still load
// on demand via `ensureLangLoaded`, so a missing entry here is not "unsupported".
//
// Exported because it is the target set `normalizeLanguage`'s alias table has to
// land on: `highlightSync` gates on `loadedLangs.has(lang)`, which is seeded from
// this list verbatim. An alias pointing anywhere else still highlights, but only
// after the async round trip — i.e. with the plain→colour flash this preload
// exists to prevent. A unit test pins that invariant.
export const PRELOAD_LANGS = [
  // plain / config
  'text',
  'json',
  'jsonc',
  'yaml',
  'toml',
  'ini',
  'dotenv',
  'xml',
  'diff',
  // web
  'html',
  'css',
  'scss',
  'less',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'vue',
  'svelte',
  'astro',
  'markdown',
  'mdx',
  // backend / systems
  'python',
  'ruby',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'php',
  'sql',
  'lua',
  'r',
  'dart',
  'elixir',
  // shell / ops / data
  'bash',
  'powershell',
  'dockerfile',
  'nginx',
  'makefile',
  'hcl',
  'terraform',
  'graphql',
  'prisma',
  'proto',
  // diagrams
  'mermaid',
  'txt',
  'text',
];

// Strip Shiki's wrapper background/tabindex and any per-token font-weight/style —
// forcing a uniform weight keeps highlighted DOM the same width as plain text, so
// the colour swap never shifts glyphs horizontally.
const shikiTransformers: ShikiTransformer[] = [
  {
    pre(node) {
      if (typeof node.properties.style === 'string') {
        node.properties.style = node.properties.style.replace(/background-color:[^;]+;?/g, '');
      }
      delete node.properties.tabindex;
    },
    span(node) {
      if (typeof node.properties.style === 'string') {
        node.properties.style = node.properties.style
          .replace(/font-weight:[^;]+;?/g, '')
          .replace(/font-style:[^;]+;?/g, '');
      }
    },
  },
];

// Singleton highlighter — kicked off at module init so the grammar is usually
// ready by first render, letting us highlight synchronously (no plain→colour flash).
//
// Shiki's oniguruma engine compiles to WebAssembly, so skip the eager init
// entirely (and never leave a rejecting promise) when WebAssembly is unavailable
// — otherwise the rejection fires `onunhandledrejection` → Sentry on every page
// load for visitors whose browser blocks/disables WebAssembly. highlightAsync
// treats a null highlighter as "no highlighting available" and renders plain
// code. See Better Stack 1604d50a (`WebAssembly is not defined`).
let highlighterReady: Highlighter | null = null;
const loadedLangs = new Set<string>(PRELOAD_LANGS.map((l) => l.toLowerCase()));
const langLoadPromises = new Map<string, Promise<void>>();

// The markdown pair is built into the singleton below, so it starts loaded.
// Every other palette — Pierre included — arrives through `ensureThemeLoaded`,
// which keeps its TextMate JSON out of the initial highlight path.
const loadedThemes = new Set<string>([SHIKI_THEME_DARK, SHIKI_THEME_LIGHT]);
const themeLoadPromises = new Map<string, Promise<void>>();

const highlighterPromise: Promise<Highlighter | null> = shikiWasmAvailable()
  ? getSingletonHighlighter({
      themes: [SHIKI_THEME_DARK, SHIKI_THEME_LIGHT],
      langs: PRELOAD_LANGS,
    })
      .then((h) => {
        highlighterReady = h;
        return h;
      })
      .catch((err) => {
        console.warn('[markdown-code] Shiki highlighter init failed:', err);
        return null;
      })
  : Promise.resolve(null);

function ensureLangLoaded(h: Highlighter, lang: string): Promise<void> {
  if (loadedLangs.has(lang)) return Promise.resolve();
  const existing = langLoadPromises.get(lang);
  if (existing) return existing;
  const p = h
    .loadLanguage(lang as never)
    .then(() => {
      loadedLangs.add(lang);
    })
    .catch((err) =>
      console.warn(`[markdown-code] failed to load Shiki lang "${lang}":`, err?.message || err),
    )
    .finally(() => {
      langLoadPromises.delete(lang);
    });
  langLoadPromises.set(lang, p);
  return p;
}

function ensureThemeLoaded(h: Highlighter, theme: CodeThemeInput): Promise<void> {
  const { name, input } = resolveCodeTheme(theme);
  if (loadedThemes.has(name)) return Promise.resolve();
  const existing = themeLoadPromises.get(name);
  if (existing) return existing;
  const p = h
    .loadTheme(input as never)
    .then(() => {
      loadedThemes.add(name);
    })
    .catch((err) =>
      console.warn(`[markdown-code] failed to load Shiki theme "${name}":`, err?.message || err),
    )
    .finally(() => {
      themeLoadPromises.delete(name);
    });
  themeLoadPromises.set(name, p);
  return p;
}

function clampCode(code: string): string {
  return code.length > SHIKI_MAX_LENGTH
    ? code.slice(0, SHIKI_MAX_LENGTH) + '\n// ... (truncated for highlighting)'
    : code;
}

// Bounded cache keyed by (lang, theme, content signature). Survives the component
// remounts Streamdown triggers per token, so repeat highlights are free.
const shikiCache = new Map<string, string>();
const shikiPending = new Map<string, Promise<string | null>>();
const SHIKI_CACHE_MAX = 64;

function shikiKey(code: string, lang: string, theme: string): string {
  const sig = code.length <= 200 ? code : code.slice(0, 100) + code.slice(-100) + code.length;
  return `${lang}:${theme}:${sig}`;
}

function cacheHtml(key: string, html: string) {
  shikiCache.set(key, html);
  if (shikiCache.size > SHIKI_CACHE_MAX) {
    const oldest = shikiCache.keys().next().value;
    if (oldest !== undefined) shikiCache.delete(oldest);
  }
}

// Synchronous highlight when the grammar and the theme are ready (the common
// case). Returns null while either is still loading, so callers fall back to async.
export function highlightSync(
  code: string,
  language: string,
  theme: CodeThemeInput,
): string | null {
  const lang = normalizeLanguage(language);
  const { name } = resolveCodeTheme(theme);
  const key = shikiKey(code, lang, name);
  const cached = shikiCache.get(key);
  if (cached) return cached;
  if (!highlighterReady || !loadedLangs.has(lang) || !loadedThemes.has(name)) return null;
  try {
    const html = highlighterReady.codeToHtml(clampCode(code), {
      lang,
      theme: name,
      transformers: shikiTransformers,
    });
    cacheHtml(key, html);
    return html;
  } catch {
    return null;
  }
}

export function highlightAsync(
  code: string,
  language: string,
  theme: CodeThemeInput,
): Promise<string | null> {
  const lang = normalizeLanguage(language);
  const { name, input } = resolveCodeTheme(theme);
  const key = shikiKey(code, lang, name);
  const cached = shikiCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = shikiPending.get(key);
  if (inflight) return inflight;

  const p = highlighterPromise
    .then(async (h) => {
      if (!h) return null;
      await Promise.all([ensureLangLoaded(h, lang), ensureThemeLoaded(h, theme)]);
      return h.codeToHtml(clampCode(code), { lang, theme: name, transformers: shikiTransformers });
    })
    // The one-off highlighter this falls back to has nothing registered, so it
    // takes the input (bundled name or registration object), not the key name.
    .catch(() =>
      codeToHtml(clampCode(code), {
        lang,
        theme: input as never,
        transformers: shikiTransformers,
      }),
    )
    .then((html) => {
      // null = the highlighter isn't available (yet) — don't negative-cache
      // it, so a later call can retry once the highlighter is up.
      if (html !== null) cacheHtml(key, html);
      shikiPending.delete(key);
      return html;
    })
    .catch((err) => {
      console.warn(`[markdown-code] Shiki failed for lang="${lang}":`, err?.message || err);
      shikiPending.delete(key);
      return null;
    });
  shikiPending.set(key, p);
  return p;
}

export const SHIKI_RESET = cn(
  'text-sm font-mono leading-[1.65] whitespace-pre',
  '[&_pre]:contents [&_code]:contents',
  '[&_.line]:m-0 [&_.line]:p-0 [&_.line]:border-none [&_.line]:outline-none [&_.line]:shadow-none',
);

export { clampCode, shikiKey };
export const __testing = {
  shikiCache,
  SHIKI_CACHE_MAX,
  cacheHtml,
  loadedLangs,
  loadedThemes,
  themeLoadPromises,
  ensureThemeLoaded,
  resolveCodeTheme,
};
