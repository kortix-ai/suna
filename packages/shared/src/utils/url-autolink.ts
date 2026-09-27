/**
 * URL Auto-linking Utility
 *
 * Detects plain URLs (with or without protocol) and converts them to markdown links.
 * Handles patterns like:
 * - github.com/kubet/mk-blog
 * - https://github.com/kubet/mk-blog
 * - www.example.com
 * - example.com/path
 *
 * Safely skips content that is already inside:
 * - Markdown links: [text](url) — neither the text nor the url part
 * - Link reference definitions: [label]: url
 * - A link still being written at the end of streaming text: [text](url…
 * - Code blocks: ```...```
 * - Inline code: `...`
 * - LaTeX inline math: $...$ (currency like $4M is escaped before parsing)
 * - LaTeX block math: $$...$$
 */

// Bounded quantifiers everywhere: unbounded `+`/`*` runs on user-controlled chat
// content are polynomial-ReDoS bait (long runs that never reach `@`/TLD backtrack
// across every start index). RFC caps — local-part ≤64, domain ≤255, TLD ≤24 —
// keep every match attempt constant-work, so the whole scan stays linear.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]{1,255}\.[a-zA-Z]{2,24}/g;

// No lookbehind anywhere in this file: a regex literal with (?<!…) is a
// parse-time SyntaxError on Safari <16.4 and kills every chunk importing this
// module (chat, public share page). The old (?<![/@]) guard on the bare-domain
// alternative is enforced imperatively in autoLinkUrls via a prev-char check.
const URL_PATTERN =
  /(?:https?:\/\/(?:www\.)?|www\.)[-a-zA-Z0-9@:%._+~#=]{1,256}(?:\.[a-zA-Z0-9()]{1,6}){1,64}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.){1,64}(?:com|org|net|io|dev|app|ai|co|uk|de|fr|it|es|jp|cn|in|br|au|ca|us|gov|edu|xyz|info|tech|online|site|me|cc|ws|name|mobi|tv|biz|us|eu|academy|agency|blog|chat|cloud|digital|email|finance|global|health|legal|media|money|news|page|shop|store|studio|ventures|vc|world)\b(?:\/[-a-zA-Z0-9()@:%_+.~#?&/=]*)?/g;

/**
 * Character scan for unescaped `$…$` inline-math spans (interior non-empty,
 * single-line, `\$` never opens or closes). Replaces the previous
 * `/(?<!\\)\$[^$\n]+(?<!\\)\$/g` regex — see the no-lookbehind note above.
 */
function pushInlineMathRanges(text: string, ranges: Array<[number, number]>): void {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      start = -1;
      continue;
    }
    if (ch !== '$') continue;
    if (i > 0 && text[i - 1] === '\\') continue;
    if (start === -1) start = i;
    else if (i - start > 1) {
      ranges.push([start, i]);
      start = -1;
    } else {
      start = i;
    }
  }
}

/**
 * Checks if a given character index inside `text` is within a "protected" zone —
 * i.e. already inside a markdown link, code span, code block, or LaTeX math.
 *
 * Returns a Set of all character indices that are inside protected zones.
 */
function buildProtectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // ── Fenced code blocks  ```...``` ────────────────────────────────────────
  const fenceRe = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length - 1]);
  }

  // ── Inline code  `...` ───────────────────────────────────────────────────
  const inlineCodeRe = /`[^`\n]+`/g;
  while ((m = inlineCodeRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length - 1]);
  }

  // ── Block math  $$...$$ ──────────────────────────────────────────────────
  const blockMathRe = /\$\$[\s\S]*?\$\$/g;
  while ((m = blockMathRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length - 1]);
  }

  // ── Inline math  $...$ (not markdown-escaped \$ currency) ───────────────
  pushInlineMathRanges(text, ranges);

  // ── Markdown links  [text](url) ─────────────────────────────────────────
  // Protect BOTH the link-text part AND the url part so we never re-process them.
  const linkRe = /\[([^\]]{0,4096})\]\(([^)]{0,8192})\)/g;
  while ((m = linkRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length - 1]);
  }

  // ── Link reference definitions  [label]: https://… ──────────────────────
  // The target of every `[text][label]`. Wrapping its URL corrupts the
  // definition, and each reference then renders as `text [blocked]`. Up to
  // three spaces of indent, as in CommonMark; four makes an indented code block.
  const definitionRe = /^ {0,3}\[[^\]\n]{1,999}\]:[^\n]*/gm;
  while ((m = definitionRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length - 1]);
  }

  // ── Bare markdown link references  <url> ────────────────────────────────
  const angleRe = /<(?:https?:\/\/|mailto:)[^>\n]{1,8192}>/g;
  while ((m = angleRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length - 1]);
  }

  // ── A link still being written at the very end  [text](url… ─────────────
  const openLink = openMarkdownLinkAtEnd(text);
  if (openLink) ranges.push([openLink.start, text.length - 1]);

  return ranges;
}

/** A markdown link the text ends inside of. See `openMarkdownLinkAtEnd`. */
export interface OpenMarkdownLink {
  /** Index of the `[` that opens the link. */
  start: number;
  /** The label so far: up to `]`, or to the end while the label is still open. */
  label: string;
  /** The destination so far, or `null` while the label is still open. */
  destination: string | null;
}

/**
 * The markdown link left open at the very end of the text, or null.
 *
 * Only streaming text ends inside a link: `[label` with no `]` yet, or
 * `[label](https://…` with no `)` yet. Linkifying the half-written URL there
 * wraps it in a second link — `[label]([https://…](https://…)` — so the reader
 * sees a raw `[label](` until the closing paren arrives. `autoLinkUrls` leaves
 * it as written and Streamdown's remend closes it for display; the web renderer
 * also reads it to show a setup link as a pending card while it arrives.
 *
 * Only the last line counts, so a stray `[` earlier in the text is never open.
 * Plain index scans, not a `$`-anchored regex: that backtracks quadratically on
 * a run of `[` followed by a newline.
 */
export function openMarkdownLinkAtEnd(text: string): OpenMarkdownLink | null {
  const lineStart = text.lastIndexOf('\n') + 1;

  // Destination still open: the last `](` on the line, with no `)` after it.
  const destination = text.lastIndexOf('](');
  if (destination >= lineStart && text.indexOf(')', destination + 2) === -1) {
    const start = text.lastIndexOf('[', destination);
    if (start >= lineStart) {
      return {
        start,
        label: text.slice(start + 1, destination),
        destination: text.slice(destination + 2),
      };
    }
  }

  // Label still open: the last `[` on the line, with no `]` after it.
  const start = text.lastIndexOf('[');
  if (start >= lineStart && text.indexOf(']', start + 1) === -1) {
    return { start, label: text.slice(start + 1), destination: null };
  }

  return null;
}

function isInProtectedRange(
  index: number,
  length: number,
  ranges: Array<[number, number]>,
): boolean {
  const end = index + length - 1;
  for (const [start, rangeEnd] of ranges) {
    // Any overlap means protected
    if (index <= rangeEnd && end >= start) return true;
  }
  return false;
}

/**
 * Auto-links plain URLs and emails in text by converting them to markdown links.
 * Already-linked content is never double-wrapped.
 */
export function autoLinkUrls(text: string): string {
  if (!text || typeof text !== 'string') return text;

  // Build protected ranges from the ORIGINAL text before any mutation.
  const ranges = buildProtectedRanges(text);

  // Collect replacements: [index, length, replacement]
  // We process emails first, then URLs, collecting all non-overlapping matches.
  const replacements: Array<{ index: number; length: number; replacement: string }> = [];
  const covered = new Set<number>(); // track indices already claimed

  // ── Emails ───────────────────────────────────────────────────────────────
  EMAIL_PATTERN.lastIndex = 0;
  let emailMatch: RegExpExecArray | null;
  while ((emailMatch = EMAIL_PATTERN.exec(text)) !== null) {
    const { index } = emailMatch;
    const email = emailMatch[0];
    if (isInProtectedRange(index, email.length, ranges)) continue;
    // Mark indices as covered
    for (let i = index; i < index + email.length; i++) covered.add(i);
    replacements.push({
      index,
      length: email.length,
      replacement: `[${email}](mailto:${email})`,
    });
  }

  // ── URLs ─────────────────────────────────────────────────────────────────
  URL_PATTERN.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = URL_PATTERN.exec(text)) !== null) {
    const { index } = urlMatch;
    const url = urlMatch[0];
    // Bare-domain matches (no protocol/www) directly after '/' or '@' are file
    // paths or email tails, not links — the old (?<![/@]) lookbehind, applied here.
    const isBareDomain = !/^(?:https?:\/\/|www\.)/i.test(url);
    if (isBareDomain && index > 0 && (text[index - 1] === '/' || text[index - 1] === '@')) continue;
    // Skip if overlaps a protected range or an already-claimed email
    if (isInProtectedRange(index, url.length, ranges)) continue;
    // Skip if any char in this match was already claimed by an email replacement
    let overlapsEmail = false;
    for (let i = index; i < index + url.length; i++) {
      if (covered.has(i)) {
        overlapsEmail = true;
        break;
      }
    }
    if (overlapsEmail) continue;

    // Skip bare domain matches that look like plain file paths (no TLD after /)
    // Add https:// protocol if missing
    let href = url;
    if (!/^https?:\/\//i.test(url)) {
      href = `https://${url.replace(/^www\./, '')}`;
      if (url.startsWith('www.')) href = `https://${url}`;
    }

    replacements.push({ index, length: url.length, replacement: `[${url}](${href})` });
  }

  if (replacements.length === 0) return text;

  // Apply in reverse order to preserve indices
  replacements.sort((a, b) => b.index - a.index);
  let result = text;
  for (const { index, length, replacement } of replacements) {
    result = result.substring(0, index) + replacement + result.substring(index + length);
  }
  return result;
}
