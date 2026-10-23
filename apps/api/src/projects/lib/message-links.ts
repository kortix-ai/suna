/**
 * The http(s) links in a person's message, as a channel's Links tab stores
 * them (`project-space-links.ts`): parsed form (`new URL(url).href`), at most
 * 2,048 characters, no credentials, each address once, at most 20.
 */

export const MESSAGE_LINKS_MAX = 20;
const URL_MAX = 2048;

/** A quoted earlier message (`<reply_context>`) is not what this person wrote. */
const REPLY_CONTEXT = /<reply_context\b[\s\S]*?<\/reply_context>/gi;
/** A candidate: from the scheme to whitespace or a character no bare link carries. */
const CANDIDATE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Punctuation that ends a sentence or wraps a link (`**url**`, `url.`), not part of it. */
const TRAILING = /[.,;:!?*_~]+$/;
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** `url` without trailing punctuation and closing brackets it does not open (`[x](url)`, `(see url)`). */
function trimTail(url: string): string {
  let out = url;
  for (;;) {
    const before = out;
    out = out.replace(TRAILING, '');
    const last = out.at(-1);
    const open = last ? PAIRS[last] : undefined;
    if (open && out.split(open).length < out.split(last!).length) out = out.slice(0, -1);
    if (out === before) return out;
  }
}

export function extractMessageLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.replace(REPLY_CONTEXT, ' ').matchAll(CANDIDATE)) {
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
