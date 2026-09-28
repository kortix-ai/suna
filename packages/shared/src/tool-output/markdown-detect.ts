import { isDigit, isLineTerminator, whitespaceEnd } from './scan';

/**
 * Does this free-form text actually contain markdown syntax?
 *
 * Pure + deliberately conservative: plain multi-line text — including simple
 * `-` bullet lists — must NOT match. Callers use a false result to keep their
 * own plain-text treatment (review-center's per-line checkmarks, a tool's
 * monospace output block), so a false positive silently replaces a designed
 * rendering with a generic one. Only unambiguous syntax counts.
 */

const MD_SIGNALS: RegExp[] = [
  /^#{1,6}\s+\S/m, // ATX heading: "## What this changes"
  /```/, // fenced code block
  /\*\*[^*\n]+\*\*/, // bold
  /(^|[^`])`[^`\n]+`([^`]|$)/, // inline code span (not a fence)
];

/**
 * Does this free-form text contain unambiguous markdown syntax? The first four
 * signals are regexes; a `[link](url)` and an ordered-list item are read by
 * the scanners below, which return what their regexes returned.
 */
export function looksLikeMarkdown(text: string): boolean {
  return (
    MD_SIGNALS.some((re) => re.test(text)) || hasMarkdownLink(text) || hasOrderedListItem(text)
  );
}

/** The first `a` or `b` at or after a position, remembered while the queries move forward. */
function nextOfEither(text: string, a: number, b: number): (at: number) => number {
  let from = Number.POSITIVE_INFINITY;
  let found = -1;
  return (at: number): number => {
    if (at >= from && (found === -1 || at <= found)) return found;
    from = at;
    found = -1;
    for (let i = at; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === a || code === b) {
        found = i;
        break;
      }
    }
    return found;
  };
}

/**
 * Whether a `[text](url)` link, each part on one line, occurs, as
 * `/\[[^\]\n]+\]\([^)\n]+\)/` found it. The regex rescanned the rest of the
 * line for every `[` whose link never closed: 60k `[a](` took 8.7 s.
 */
export function hasMarkdownLink(text: string): boolean {
  const labelEnd = nextOfEither(text, 93, 10); // ] or \n
  const urlEnd = nextOfEither(text, 41, 10); // ) or \n
  for (let open = text.indexOf('['); open !== -1; ) {
    const close = labelEnd(open + 1);
    // No `]` and no newline after this `[`: no link can follow.
    if (close === -1) return false;
    if (close > open + 1 && text.charCodeAt(close) === 93 && text.charCodeAt(close + 1) === 40) {
      const end = urlEnd(close + 2);
      if (end === -1) return false;
      if (end > close + 2 && text.charCodeAt(end) === 41) return true;
    }
    // Every `[` before `close` reaches the same `close`: skip past it.
    open = text.indexOf('[', close + 1);
  }
  return false;
}

/**
 * Whether a line starts an ordered-list item, as `/^\s*\d+\.\s+\S/m` found it.
 * `\s*` crosses lines, so every line start inside one whitespace run reaches
 * the same text: the regex retried each one, and 240k blank lines took 22.4 s.
 */
export function hasOrderedListItem(text: string): boolean {
  for (let at = 0; at <= text.length; ) {
    const digits = whitespaceEnd(text, at);
    let dot = digits;
    while (isDigit(text.charCodeAt(dot))) dot++;
    if (dot > digits && text.charCodeAt(dot) === 46) {
      const next = whitespaceEnd(text, dot + 1);
      if (next > dot + 1 && next < text.length) return true;
    }
    // The next line start after the whitespace run.
    let end = digits;
    while (end < text.length && !isLineTerminator(text.charCodeAt(end))) end++;
    at = end + 1;
  }
  return false;
}
