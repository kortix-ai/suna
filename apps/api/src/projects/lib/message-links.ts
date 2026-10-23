/**
 * The http(s) links in a person's message, as a channel's Links tab stores
 * them (`project-space-links.ts`): parsed form (`new URL(url).href`), at most
 * 2,048 characters, no credentials, each address once, at most 20.
 * Every step is linear in the scanned text (at most `MESSAGE_SCAN_MAX`
 * characters), so a crafted message cannot stall the API.
 */

export const MESSAGE_LINKS_MAX = 20;
const URL_MAX = 2048;
/** Only the start of a long message is scanned. */
export const MESSAGE_SCAN_MAX = 64 * 1024;

const REPLY_OPEN = '<reply_context';
const REPLY_CLOSE = '</reply_context>';

/**
 * `text` without its quoted earlier messages (`<reply_context …>…</reply_context>`,
 * the composer's reply quote): they are not what this person wrote. An opener
 * with no closer drops the rest. One forward pass with `indexOf`: linear.
 */
function stripReplyContexts(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf(REPLY_OPEN, from);
    if (open === -1) return out + text.slice(from);
    const next = text[open + REPLY_OPEN.length];
    // `<reply_contexts` is not the tag: keep it and look past it.
    if (next !== undefined && next !== '>' && !/\s/.test(next)) {
      out += text.slice(from, open + REPLY_OPEN.length);
      from = open + REPLY_OPEN.length;
      continue;
    }
    const close = text.indexOf(REPLY_CLOSE, open + REPLY_OPEN.length);
    if (close === -1) return out + text.slice(from, open);
    out += text.slice(from, open) + ' ';
    from = close + REPLY_CLOSE.length;
  }
}
/** A candidate: from the scheme to whitespace or a character no bare link carries. */
const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Punctuation that ends a sentence or wraps a link (`**url**`, `url.`), not part of it. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '*', '_', '~']);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * `url` without trailing punctuation and closing brackets it does not open
 * (`[x](url)`, `(see url)`). One count of each bracket, then one pass from the end.
 */
function trimTail(url: string): string {
  const balance: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
  for (const ch of url) {
    if (ch in CLOSERS) balance[ch]!--;
    else if (ch === '(') balance[')']!++;
    else if (ch === '[') balance[']']!++;
    else if (ch === '{') balance['}']!++;
  }
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (TRAILING.has(ch)) end--;
    else if (ch in CLOSERS && balance[ch]! < 0) {
      // More closers than openers: this one opens nothing.
      balance[ch]!++;
      end--;
    } else break;
  }
  return url.slice(0, end);
}

export function extractMessageLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of stripReplyContexts(text.slice(0, MESSAGE_SCAN_MAX)).matchAll(CANDIDATE)) {
    // A candidate over the cap is skipped before trimming, even if it would normalize shorter.
    if (match[0].length > URL_MAX) continue;
    let url: URL;
    try {
      url = new URL(trimTail(match[0]));
    } catch {
      continue;
    }
    if (url.username || url.password || url.href.length > URL_MAX) continue;
    found.add(url.href);
    if (found.size === MESSAGE_LINKS_MAX) break;
  }
  return [...found];
}
