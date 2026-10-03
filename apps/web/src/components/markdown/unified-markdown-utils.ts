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

/** Base for resolving a relative image URL when there is no window (server render, tests). */
const NO_WINDOW_PAGE_URL = 'https://page.invalid/';

/**
 * The host a markdown image would be fetched from, when that host is not this
 * app. `null` for a same-origin or relative source, for `data:` and `blob:`,
 * and for a source the sandbox proxy rewrote (`proxiedSrc !== src`): that is
 * the session's own file served through the API, not a third party.
 *
 * The URL is resolved against the page exactly as the browser will fetch it,
 * so protocol-relative (`//host`), backslash (`\\host`), padded and
 * mixed-case forms are classified by where they actually point. Anything that
 * resolves off this origin is remote; a source that does not parse is too.
 */
export function remoteImageHost(src: string, proxiedSrc: string = src): string | null {
  if (proxiedSrc !== src) return null;
  const page = typeof window !== 'undefined' ? window.location.href : NO_WINDOW_PAGE_URL;
  let url: URL;
  try {
    url = new URL(src, page);
  } catch {
    return src.trim().slice(0, 64) || null;
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return null;
  if (url.origin === new URL(page).origin) return null;
  return url.host || url.protocol;
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

export { LANGUAGE_ALIASES, normalizeLanguage, languageLabel } from '@kortix/shared/code-language';

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
