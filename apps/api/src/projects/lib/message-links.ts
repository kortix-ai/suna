/**
 * The http(s) links in a person's message, as a channel's Links tab stores
 * them (`project-space-links.ts`): parsed form (`new URL(url).href`), at most
 * 2,048 characters, no credentials, each address once, at most 20.
 * Linear in the text: a crafted message cannot stall the API.
 */

export const MESSAGE_LINKS_MAX = 20;
const URL_MAX = 2048;
/** Only the start of a long message is scanned. */
export const MESSAGE_SCAN_MAX = 64 * 1024;

/** A quoted earlier message (`<reply_context>`) is not what this person wrote. */
const REPLY_CONTEXT = /<reply_context\b[\s\S]*?<\/reply_context>/gi;
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
  for (const match of text.slice(0, MESSAGE_SCAN_MAX).replace(REPLY_CONTEXT, ' ').matchAll(CANDIDATE)) {
    // Trimming and normalizing never shortens a candidate this long under the cap.
    if (match[0].length > URL_MAX + 64) continue;
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
