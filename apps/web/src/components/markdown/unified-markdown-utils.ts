import { holdPendingSetupLink } from '@/components/setup-links/util';
import { stripKortixSystemTags } from '@/lib/utils/kortix-system-tags';
import { looksLikeFilePath as sharedLooksLikeFilePath } from '@/lib/utils/path-detection';
import { autoLinkUrls } from '@kortix/shared';
import { prepareMarkdownForKatex } from '@kortix/shared/markdown-math';

// Pure, deterministic helpers used by the unified markdown renderer. Extracted
// so they can be unit-tested without pulling in React / Shiki / Streamdown.

/**
 * The text Streamdown parses: KaTeX delimiters normalised, system tags removed,
 * bare URLs linked.
 *
 * While the message streams, a setup link whose URL is still arriving is held
 * as a pending card first (`holdPendingSetupLink`), so the reader never sees
 * its raw `[label](` or a card built from a partial token. Settled text is
 * never held.
 */
export function prepareMarkdownSource(content: string, isStreaming: boolean): string {
  const prepared = stripKortixSystemTags(prepareMarkdownForKatex(content));
  return autoLinkUrls(isStreaming ? holdPendingSetupLink(prepared) : prepared);
}

/** A reference-style link target: `[label]: destination`, up to three spaces in. */
const LINK_REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*\S/m;

/**
 * Does this markdown define a reference-style link target (`[1]: https://…`)?
 *
 * Streamdown parses a streaming message block by block, and a definition in
 * one block cannot resolve a `[text][1]` in another: the reference renders as
 * raw brackets. A message with a definition is therefore parsed whole, which is
 * what Streamdown already does for footnotes.
 */
export function hasLinkReferenceDefinition(markdown: string): boolean {
  return LINK_REFERENCE_DEFINITION.test(markdown);
}

/**
 * Is this href Streamdown's stand-in for a URL that has not arrived yet?
 *
 * While a message streams, Streamdown's `remend` closes a half-written link as
 * `[label](streamdown:incomplete-link)` so the label renders before the URL is
 * complete. That href is not a destination. It must never become an anchor.
 */
export function isStreamingLinkPlaceholder(href: string | undefined): boolean {
  return !!href && /^streamdown:/i.test(href);
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
