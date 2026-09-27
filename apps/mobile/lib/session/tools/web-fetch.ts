/**
 * Pure logic behind the web-page tool renderers: `web-fetch-tool.tsx` and
 * `scrape-webpage-tool.tsx`.
 *
 * Ported from apps/web:
 * - `lib/safe-url.ts` `safeHttpUrl`;
 * - `features/session/preview-url-fallback.ts` `prefersPreviewLink`;
 * - `features/session/tool/tool-renderers-sanitization.ts`
 *   `extractReadableHtml` (a tag scanner, not a DOM parser — no DOM on mobile);
 * - `tool/tools/web-fetch-tool.tsx` trigger + error summary;
 * - `tool/tools/scrape-webpage-tool.tsx` content cap and row keys (web computes
 *   a "N pages" badge but never draws it, so it is not ported).
 */

import { looksLikeHtml, type ScrapeResult } from '@kortix/sdk';

// ─── URLs ────────────────────────────────────────────────────────────────────

/** An http(s) URL, normalised; `null` for anything else. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const LINK_ONLY_PREVIEW_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?)(?:[?#]|$)/i;

/** A document URL is shown as a link, not an embedded preview. */
export function prefersPreviewLink(candidateUrl: string | null): boolean {
  if (!candidateUrl) return false;
  try {
    const url = new URL(candidateUrl);
    return LINK_ONLY_PREVIEW_EXT_RE.test(`${url.pathname}${url.search}`);
  } catch {
    return LINK_ONLY_PREVIEW_EXT_RE.test(candidateUrl);
  }
}

// ─── Readable HTML ───────────────────────────────────────────────────────────

type HtmlTag = { name: string; closing: boolean };

const SKIP_CONTENT_TAGS = new Set(['head', 'script', 'style']);
const READABLE_BREAK_TAGS = new Set([
  'article',
  'br',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'p',
  'section',
  'tr',
  'ul',
]);

/** The page `<title>` and its visible text, one block per line. */
export function extractReadableHtml(html: string): { title?: string; text: string } {
  const title = extractTitle(html);
  const text = normalizeReadableText(decodeHtmlEntitiesOnce(extractHtmlText(html)));
  return { title, text };
}

function decodeHtmlEntitiesOnce(s: string): string {
  let decoded = '';
  let index = 0;
  while (index < s.length) {
    if (s[index] !== '&') {
      decoded += s[index];
      index += 1;
      continue;
    }
    const end = s.indexOf(';', index + 1);
    if (end === -1 || end - index > 16) {
      decoded += s[index];
      index += 1;
      continue;
    }
    const replacement = decodeEntity(s.slice(index + 1, end));
    if (replacement === undefined) {
      decoded += s[index];
      index += 1;
      continue;
    }
    decoded += replacement;
    index = end + 1;
  }
  return decoded;
}

function extractTitle(html: string): string | undefined {
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart === -1) return undefined;
    const tagEnd = findTagCloseIndex(html, tagStart);
    if (tagEnd === -1) return undefined;
    const tag = readTag(html.slice(tagStart + 1, tagEnd));
    if (!tag.closing && tag.name === 'title') {
      const closing = findClosingTagRange(html, tagEnd + 1, 'title');
      const rawTitle = html.slice(tagEnd + 1, closing?.start ?? html.length);
      return normalizeInlineText(decodeHtmlEntitiesOnce(stripTagLikeSegments(rawTitle)));
    }
    index = tagEnd + 1;
  }
  return undefined;
}

function extractHtmlText(html: string): string {
  let text = '';
  let index = 0;
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      index = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    if (html[index] !== '<') {
      text += html[index];
      index += 1;
      continue;
    }
    const tagEnd = findTagCloseIndex(html, index);
    if (tagEnd === -1) break;
    const tag = readTag(html.slice(index + 1, tagEnd));
    if (!tag.closing && SKIP_CONTENT_TAGS.has(tag.name)) {
      const closing = findClosingTagRange(html, tagEnd + 1, tag.name);
      index = closing?.end ?? html.length;
      continue;
    }
    if (READABLE_BREAK_TAGS.has(tag.name)) text += '\n';
    index = tagEnd + 1;
  }
  return text;
}

function stripTagLikeSegments(input: string): string {
  let text = '';
  let index = 0;
  while (index < input.length) {
    if (input.startsWith('<!--', index)) {
      const commentEnd = input.indexOf('-->', index + 4);
      index = commentEnd === -1 ? input.length : commentEnd + 3;
      continue;
    }
    if (input[index] !== '<') {
      text += input[index];
      index += 1;
      continue;
    }
    const tagEnd = findTagCloseIndex(input, index);
    if (tagEnd === -1) break;
    index = tagEnd + 1;
  }
  return text;
}

function findClosingTagRange(
  html: string,
  fromIndex: number,
  tagName: string,
): { start: number; end: number } | undefined {
  let index = fromIndex;
  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart === -1) return undefined;
    const tagEnd = findTagCloseIndex(html, tagStart);
    if (tagEnd === -1) return undefined;
    const tag = readTag(html.slice(tagStart + 1, tagEnd));
    if (tag.closing && tag.name === tagName) return { start: tagStart, end: tagEnd + 1 };
    index = tagEnd + 1;
  }
  return undefined;
}

function findTagCloseIndex(input: string, tagStart: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = tagStart + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

function readTag(rawTag: string): HtmlTag {
  let index = 0;
  while (index < rawTag.length && isWhitespace(rawTag[index])) index += 1;
  const closing = rawTag[index] === '/';
  if (closing) index += 1;
  while (index < rawTag.length && isWhitespace(rawTag[index])) index += 1;
  const nameStart = index;
  while (index < rawTag.length && isNameChar(rawTag[index])) index += 1;
  return { name: rawTag.slice(nameStart, index).toLowerCase(), closing };
}

function decodeEntity(entity: string): string | undefined {
  const lower = entity.toLowerCase();
  if (lower === 'nbsp') return ' ';
  if (lower === 'amp') return '&';
  if (lower === 'lt') return '<';
  if (lower === 'gt') return '>';
  if (lower === 'quot') return '"';
  if (lower === 'apos') return "'";
  if (!lower.startsWith('#')) return undefined;
  const numeric = lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  try {
    return String.fromCodePoint(numeric);
  } catch {
    return undefined;
  }
}

function normalizeReadableText(text: string): string {
  return text.split('\n').map(normalizeInlineText).filter(Boolean).join('\n');
}

function normalizeInlineText(text: string): string {
  let normalized = '';
  let pendingSpace = false;
  for (const char of text) {
    if (isWhitespace(char)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      pendingSpace = false;
    }
    normalized += char;
  }
  return normalized.trim();
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

function isNameChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === ':' ||
    char === '-' ||
    char === '_'
  );
}

// ─── Web fetch ───────────────────────────────────────────────────────────────

/** Characters of readable text shown under a fetched page. */
export const WEB_FETCH_READABLE_CHARS = 4000;
/** Characters of raw HTML behind "View raw HTML". */
export const WEB_FETCH_RAW_HTML_CHARS = 8000;

/** The page's own title leads; its domain is the subtitle when they differ. */
export function webFetchTrigger({
  url,
  format,
  pageTitle,
  domain,
}: {
  url: string;
  format: string;
  pageTitle: string | undefined;
  domain: string;
}): { title: string; subtitle: string | undefined; args: string[] | undefined } {
  const title = pageTitle?.trim();
  const showDomainSubtitle = Boolean(title && title !== domain);
  return {
    title: title || domain || url,
    subtitle: showDomainSubtitle ? domain : undefined,
    args: format ? [format] : undefined,
  };
}

export function webFetchErrorSummary(output: string): string {
  return output.replace(/^Error:\s*/i, '').trim();
}

// ─── Scrape webpage ──────────────────────────────────────────────────────────

const MAX_SCRAPE_CONTENT_CHARS = 8000;

export function capScrapeContent(content: string): string {
  return content.length > MAX_SCRAPE_CONTENT_CHARS
    ? content.slice(0, MAX_SCRAPE_CONTENT_CHARS).trimEnd() + '…'
    : content;
}

export function getScrapeContent(result: ScrapeResult): { content: string; allowHtml?: boolean } {
  if (!result.success && result.error) return { content: result.error };
  const content = result.content?.trim();
  if (!content) return { content: 'No content extracted.' };
  const capped = capScrapeContent(content);
  if (looksLikeHtml(capped)) return { content: capped, allowHtml: true };
  return { content: capped };
}

/** Stable, unique row keys: a repeated URL gets `#n`. */
export function scrapeResultKeys(results: ScrapeResult[]): string[] {
  const seen = new Map<string, number>();
  return results.map((result) => {
    const n = seen.get(result.url) ?? 0;
    seen.set(result.url, n + 1);
    return n ? `${result.url}#${n}` : result.url;
  });
}
