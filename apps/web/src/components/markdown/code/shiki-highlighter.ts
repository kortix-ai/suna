import { normalizeLanguage } from '@/components/markdown/unified-markdown-utils';
import { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT, type CodeThemeName } from '@/lib/code-theme';
import { cn } from '@/lib/utils';
import { createHighlighterCore, type HighlighterCore, type ShikiTransformer } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';

// ─── Shiki highlighting ──────────────────────────────────────────────────────
// One engine, one palette. Every code surface in the app renders under the same
// pair — see `@/lib/code-theme`, which also explains why the constants live in a
// module of their own rather than here.
export { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT, type CodeThemeName };

const SHIKI_MAX_LENGTH = 50_000;

/**
 * Grammars the highlighter loads when it is first created — the handful AI
 * agents emit most. Every other grammar Shiki bundles loads on demand
 * (`ensureLangLoaded`), one chunk per language, the first time a block uses it.
 *
 * This list used to hold ~58 grammars loaded at MODULE INIT: opening any page
 * that imported the markdown renderer fetched 57 grammar chunks (~500 KB
 * brotli) whether or not it showed a single code block. Now nothing loads
 * until the first block asks for a highlight.
 */
export const PRELOAD_LANGS = [
  'json',
  'yaml',
  'diff',
  'bash',
  'python',
  'javascript',
  'typescript',
  'tsx',
  'markdown',
];

/**
 * Hints that are plain text. Shiki's core highlights these without a grammar,
 * so they never wait for a load.
 */
const PLAIN_LANGS = new Set(['text', 'txt', 'plain', 'plaintext']);

/**
 * Grammar ids `normalizeLanguage` may resolve to: plain text, or any grammar
 * Shiki bundles (loadable on demand). A hint outside this set renders plain.
 */
export function isKnownLanguage(lang: string): boolean {
  return PLAIN_LANGS.has(lang) || lang in bundledLanguages;
}

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

// Singleton highlighter, created on the FIRST highlight request — not at module
// init — with the JavaScript regex engine. The Oniguruma engine needs a
// WebAssembly module (a separate ~230 KB gzip fetch plus compile) and fails
// outright where WebAssembly is blocked; the JavaScript engine produces the
// same HTML for every grammar in PRELOAD_LANGS and the previous preload set
// (checked token for token when this changed) and needs neither.
//
// `forgiving: true`: a grammar pattern the JavaScript engine cannot translate
// is skipped instead of failing the whole grammar, so a rare language degrades
// to partial colour rather than to plain text.
let highlighterReady: HighlighterCore | null = null;
let highlighterPromise: Promise<HighlighterCore | null> | null = null;
const loadedLangs = new Set<string>();
const langLoadPromises = new Map<string, Promise<void>>();

function loadHighlighter(): Promise<HighlighterCore | null> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = createHighlighterCore({
    themes: [bundledThemes[SHIKI_THEME_DARK](), bundledThemes[SHIKI_THEME_LIGHT]()],
    langs: PRELOAD_LANGS.map((lang) => bundledLanguages[lang as keyof typeof bundledLanguages]()),
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
    .then((h) => {
      for (const lang of PRELOAD_LANGS) loadedLangs.add(lang);
      highlighterReady = h;
      return h;
    })
    .catch((err) => {
      console.warn('[markdown-code] Shiki highlighter init failed:', err);
      return null;
    });
  return highlighterPromise;
}

function ensureLangLoaded(h: HighlighterCore, lang: string): Promise<void> {
  if (PLAIN_LANGS.has(lang) || loadedLangs.has(lang)) return Promise.resolve();
  const existing = langLoadPromises.get(lang);
  if (existing) return existing;
  const importer = bundledLanguages[lang as keyof typeof bundledLanguages];
  if (!importer) return Promise.reject(new Error(`no bundled grammar for "${lang}"`));
  const p = h
    .loadLanguage(importer())
    .then(() => {
      loadedLangs.add(lang);
    })
    .finally(() => {
      langLoadPromises.delete(lang);
    });
  langLoadPromises.set(lang, p);
  return p;
}

// `unbounded` skips the clamp entirely — for a surface whose whole point is
// showing the real, complete content (e.g. a request/response log), a clipped
// "preview" masquerading as the highlighted code is worse than plain text.
function clampCode(code: string, unbounded?: boolean): string {
  return !unbounded && code.length > SHIKI_MAX_LENGTH
    ? code.slice(0, SHIKI_MAX_LENGTH) + '\n// ... (truncated for highlighting)'
    : code;
}

// Bounded cache keyed by (lang, theme, content hash). Survives remounts, so a
// block that re-renders with the same text never re-tokenizes.
const shikiCache = new Map<string, string>();
const shikiPending = new Map<string, Promise<string | null>>();
const SHIKI_CACHE_MAX = 128;

/**
 * 53-bit string hash (cyrb53). The key used to be head(100) + tail(100) +
 * length, which served one snippet another snippet's HTML whenever an edit
 * stayed inside the middle and kept the length.
 */
function hashCode(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function shikiKey(code: string, lang: string, theme: string): string {
  return `${lang}:${theme}:${code.length}:${hashCode(code)}`;
}

function cacheHtml(key: string, html: string) {
  shikiCache.delete(key);
  shikiCache.set(key, html);
  if (shikiCache.size > SHIKI_CACHE_MAX) {
    const oldest = shikiCache.keys().next().value;
    if (oldest !== undefined) shikiCache.delete(oldest);
  }
}

function render(h: HighlighterCore, code: string, lang: string, theme: CodeThemeName, unbounded?: boolean) {
  return h.codeToHtml(clampCode(code, unbounded), {
    lang: PLAIN_LANGS.has(lang) ? 'text' : lang,
    theme,
    transformers: shikiTransformers,
  });
}

export function highlightSync(
  code: string,
  language: string,
  theme: CodeThemeName,
  opts?: { unbounded?: boolean },
): string | null {
  const lang = normalizeLanguage(language);
  const key = shikiKey(code, lang, theme);
  const cached = shikiCache.get(key);
  if (cached) return cached;
  if (!highlighterReady) {
    // First request: start the (lazy) highlighter so the async path is warm.
    void loadHighlighter();
    return null;
  }
  if (!PLAIN_LANGS.has(lang) && !loadedLangs.has(lang)) return null;
  try {
    const html = render(highlighterReady, code, lang, theme, opts?.unbounded);
    cacheHtml(key, html);
    return html;
  } catch {
    return null;
  }
}

export function highlightAsync(
  code: string,
  language: string,
  theme: CodeThemeName,
  opts?: { unbounded?: boolean },
): Promise<string | null> {
  const lang = normalizeLanguage(language);
  const key = shikiKey(code, lang, theme);
  const cached = shikiCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = shikiPending.get(key);
  if (inflight) return inflight;

  const p = loadHighlighter()
    .then(async (h) => {
      if (!h) return null;
      try {
        await ensureLangLoaded(h, lang);
      } catch (err) {
        // Unknown hint or a grammar chunk that failed to load: plain text is
        // the honest rendering. Not cached, so a later mount can retry.
        console.warn(
          `[markdown-code] failed to load Shiki lang "${lang}":`,
          (err as Error)?.message || err,
        );
        return null;
      }
      return render(h, code, lang, theme, opts?.unbounded);
    })
    .then((html) => {
      // null = the highlighter or grammar isn't available (yet) — don't
      // negative-cache it, so a later call can retry.
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
  'text-sm font-mono leading-[1.65] whitespace-pre tracking-tight',
  '[&_pre]:contents [&_code]:contents',
  '[&_.line]:m-0 [&_.line]:p-0 [&_.line]:border-none [&_.line]:outline-none [&_.line]:shadow-none',
);

export { clampCode, shikiKey };
export const __testing = {
  shikiCache,
  SHIKI_CACHE_MAX,
  cacheHtml,
  loadedLangs,
};
