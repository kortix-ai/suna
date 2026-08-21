import {
  normalizeLanguage,
  shikiWasmAvailable,
} from '@/components/markdown/unified-markdown-utils';
import { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT, type CodeThemeName } from '@/lib/code-theme';
import { cn } from '@/lib/utils';
import {
  codeToHtml,
  getSingletonHighlighter,
  type Highlighter,
  type ShikiTransformer,
} from 'shiki';

// ─── Shiki highlighting ──────────────────────────────────────────────────────
// One engine, one palette. Every code surface in the app renders under the same
// pair — see `@/lib/code-theme`, which also explains why the constants live in a
// module of their own rather than here.
export { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT, type CodeThemeName };

const SHIKI_MAX_LENGTH = 50_000;

// Pre-loaded at init; anything else lazy-loads on first use. `text` lets no-hint
// fences flow through Shiki so they render on the same colour as every other
// block — which under `min-dark` is its purple base (#b392f0), not a neutral
// grey. That is the theme's own default, not a bug here.
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

// `unbounded` skips the clamp entirely — for a surface whose whole point is
// showing the real, complete content (e.g. a request/response log), a clipped
// "preview" masquerading as the highlighted code is worse than plain text.
function clampCode(code: string, unbounded?: boolean): string {
  return !unbounded && code.length > SHIKI_MAX_LENGTH
    ? code.slice(0, SHIKI_MAX_LENGTH) + '\n// ... (truncated for highlighting)'
    : code;
}

// Bounded cache keyed by (lang, theme, content signature). Survives the component
// remounts Streamdown triggers per token, so repeat highlights are free.
const shikiCache = new Map<string, string>();
const shikiPending = new Map<string, Promise<string | null>>();
const SHIKI_CACHE_MAX = 64;

// A 53-bit content hash (two interleaved FNV-1a-style lanes, mixed at the end).
// Every character is read, so an edit anywhere in the code changes the digest --
// which is the whole point: the signature this replaced sampled head(100) +
// tail(100) + length, and any same-length edit between those windows produced a
// byte-identical key. Short of a real cryptographic digest there is no such
// thing as collision-free, but a full-content hash makes a collision an
// astronomical accident rather than the routine outcome of editing the middle
// of a snippet.
function hashCode(code: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < code.length; i++) {
    const ch = code.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function shikiKey(code: string, lang: string, theme: string): string {
  // Short snippets keep their literal text: it is already cheaper to compare
  // than to hash, and it keeps keys readable when debugging the cache.
  const sig = code.length <= 200 ? code : `${code.length}:${hashCode(code)}`;
  return `${lang}:${theme}:${sig}`;
}

function cacheHtml(key: string, html: string) {
  shikiCache.set(key, html);
  if (shikiCache.size > SHIKI_CACHE_MAX) {
    const oldest = shikiCache.keys().next().value;
    if (oldest !== undefined) shikiCache.delete(oldest);
  }
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
  if (!highlighterReady || !loadedLangs.has(lang)) return null;
  try {
    const html = highlighterReady.codeToHtml(clampCode(code, opts?.unbounded), {
      lang,
      theme,
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
  theme: CodeThemeName,
  opts?: { unbounded?: boolean },
): Promise<string | null> {
  const lang = normalizeLanguage(language);
  const key = shikiKey(code, lang, theme);
  const cached = shikiCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = shikiPending.get(key);
  if (inflight) return inflight;

  const p = highlighterPromise
    .then(async (h) => {
      if (!h) return null;
      await ensureLangLoaded(h, lang);
      return h.codeToHtml(clampCode(code, opts?.unbounded), {
        lang,
        theme,
        transformers: shikiTransformers,
      });
    })
    // Both palette halves are bundled theme names, so the one-off highlighter
    // this falls back to resolves them by name with nothing pre-registered.
    .catch(() =>
      codeToHtml(clampCode(code, opts?.unbounded), { lang, theme, transformers: shikiTransformers }),
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
};
