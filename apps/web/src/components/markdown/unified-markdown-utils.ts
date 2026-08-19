import { looksLikeFilePath as sharedLooksLikeFilePath } from '@/lib/utils/path-detection';

// Pure, deterministic helpers used by the unified markdown renderer. Extracted
// so they can be unit-tested without pulling in React / Shiki / Streamdown.

/**
 * Is the WebAssembly runtime Shiki needs available in this context?
 *
 * Shiki's oniguruma grammar engine compiles to WebAssembly. Some browsers /
 * contexts block or disable WebAssembly entirely — privacy browsers (Brave with
 * aggressive shields, LibreWolf, Tor Browser in high-security mode), hardened /
 * sandboxed WebViews, enterprise-policy-locked browsers, and scrapers/bots with
 * spoofed Chrome UAs running on runtimes without WebAssembly. In those contexts
 * eagerly kicking off `getSingletonHighlighter()` at module init leaves a
 * promise that rejects with `ReferenceError: WebAssembly is not defined` (V8) /
 * `Can't find variable: WebAssembly` (WebKit). Because the singleton starts
 * before any code block renders, the rejection has no consumer attached yet and
 * fires `onunhandledrejection` → Sentry → Better Stack.
 *
 * Gate the highlighter on this check so such visitors degrade to plain
 * (un-highlighted) code instead of paging on every page load.
 *
 * See Better Stack 1604d50a (`WebAssembly is not defined`).
 */
export function shikiWasmAvailable(): boolean {
  return typeof WebAssembly !== 'undefined';
}

/** Same-origin link? Internal links route through next/link; the rest open externally. */
export function isInternalUrl(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith('http://') || href.startsWith('https://')) return false;
  if (href.includes('://')) return false;
  return href.startsWith('/') || href.startsWith('#');
}

/**
 * Can this href be handed to `next/link` without crashing the prefetch path?
 *
 * Next.js' app-router `createPrefetchURL` (in `app-router.tsx`) does
 * `new URL(addBasePath(href), window.location.href)` and, on failure, throws
 * `Cannot prefetch '<href>' because it cannot be converted to a URL.` — which
 * fires whenever a `<Link>` carrying a malformed absolute href scrolls into
 * view (segment-cache `pingVisibleLinks`). A valid external URL is fine
 * (`isExternalURL` short-circuits prefetch); only URLs that fail `new URL()`
 * blow up, e.g. `http://:` (an empty host/port template like
 * `http://${HOST}:${PORT}` that leaked unsubstituted from content).
 *
 * Internal (`/`, `#`, `?`) and bare-relative hrefs are always safe. We only
 * reject protocol-prefixed hrefs that don't parse, so the renderer can fall
 * back to a plain `<a>` and never feed garbage to `next/link`.
 */
export function isLinkSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  // Root-relative, hash, and query links are always safe for next/link.
  if (href.startsWith('/') || href.startsWith('#') || href.startsWith('?')) {
    return true;
  }
  // Protocol-prefixed URLs must parse, or next/link's prefetch throws on
  // `new URL()` failure when the link enters the viewport.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    try {
      new URL(href);
      return true;
    } catch {
      return false;
    }
  }
  // Bare-relative paths are resolved against the current URL by next/link —
  // `new URL(..., window.location.href)` always succeeds for them.
  return true;
}

/** Route only trusted app paths through Next.js Link and its prefetcher. */
export function shouldUseNextLink(href: string | undefined): boolean {
  return isInternalUrl(href) && isLinkSafeHref(href);
}

/**
 * Fenced-code language hints that are not the id the highlighter preloads.
 *
 * Two kinds live here and both cost the reader something:
 *
 * 1. Hints Shiki has no grammar *or* alias for — `golang`, `env`, `patch`,
 *    `svg`, `psql`, `plaintext`. `ensureLangLoaded` throws on these, the catch
 *    warns, and the block renders unhighlighted forever.
 * 2. Hints Shiki resolves but only through its own alias table — `rs`, `kt`,
 *    `c++`, `ps1`. Those highlight, but `highlightSync` gates on
 *    `loadedLangs.has(lang)`, which is seeded from `PRELOAD_LANGS` verbatim, so
 *    the unresolved spelling misses the fast path and the block repaints from
 *    plain to colour a frame later.
 *
 * Every value must therefore be a `PRELOAD_LANGS` entry, not Shiki's canonical
 * id — that list carries `dockerfile`, `makefile` and `bash`, which are
 * themselves Shiki aliases (of `docker`, `make`, `shellscript`). Normalising to
 * the canonical id would be correct and still miss the sync path. The unit test
 * pins this; add an alias there and it fails until the target is preloaded.
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  // web
  htm: 'html',
  js: 'javascript',
  node: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  sass: 'scss',
  svg: 'xml',
  // backend / systems
  py: 'python',
  py3: 'python',
  python3: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  ex: 'elixir',
  exs: 'elixir',
  // shell / ops
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  'shell-session': 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  docker: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  tf: 'terraform',
  tfvars: 'terraform',
  // data / config
  yml: 'yaml',
  md: 'markdown',
  mdown: 'markdown',
  jsonl: 'json',
  ndjson: 'json',
  env: 'dotenv',
  patch: 'diff',
  gql: 'graphql',
  protobuf: 'proto',
  psql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  txt: 'text',
  plain: 'text',
  plaintext: 'text',
};

/** Normalise a fenced-code language hint to a Shiki grammar id. */
export function normalizeLanguage(lang: string): string {
  const lower = lang.toLowerCase();
  return LANGUAGE_ALIASES[lower] || lower;
}

/**
 * Hints the header shows exactly as typed, even though they normalise to
 * something else for highlighting. The grammar id is a Shiki implementation
 * detail; these spellings name a narrower thing the reader chose on purpose, and
 * collapsing them loses that — a `psql` block labelled "sql", an `svg` block
 * labelled "xml", a `c++` block labelled "cpp". Everything else takes the
 * normalised name, so the two tables cannot drift apart.
 */
const LABEL_KEEPS_INPUT = new Set([
  'c#',
  'c++',
  'console',
  'cxx',
  'hpp',
  'jsonl',
  'mysql',
  'ndjson',
  'patch',
  'postgres',
  'postgresql',
  'psql',
  'shell-session',
  'sqlite',
  'svg',
]);

/** Display label for the code-block header; empty hint falls back to "text". */
export function languageLabel(language: string): string {
  if (!language) return 'text';
  const lower = language.toLowerCase();
  if (LABEL_KEEPS_INPUT.has(lower)) return lower;
  return LANGUAGE_ALIASES[lower] || lower;
}

const FILE_EXTENSION_RE = /\.\w{1,10}$/;
const COMMON_NON_FILES = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'v1.', 'v2.']);

/** Does this inline-code text look like a clickable URL? */
export function looksLikeUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text);
}

/** Does this inline-code text look like a file path we can open in a preview? */
export function looksLikeFilePath(text: string): boolean {
  if (!text || text.length < 3 || text.length > 300) return false;
  if (text.includes(' ') || text.includes('\n')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (COMMON_NON_FILES.has(text.toLowerCase())) return false;
  if (!text.includes('/')) return false;
  if (FILE_EXTENSION_RE.test(text)) return true;
  return sharedLooksLikeFilePath(text);
}
