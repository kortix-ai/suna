/**
 * The `<reply_context>` wire format for reply quotes, React-free.
 *
 * Lives outside `message-parsing.tsx` so the composer (composer-logic.ts)
 * can import it without pulling that module's React components into its
 * graph.
 * `message-parsing.tsx` re-exports everything here, so its importers are
 * unchanged. Its only import is `@kortix/shared` (pure string helpers).
 */

import { removeSpans, replaceSpans, type TagBlock } from '@kortix/shared';

// ── Inline reply-context quotes ────────────────────────────
//
// One message can carry more than one <reply_context> block. The composer
// writes its quotes as leading blocks, one per line; older messages can hold
// blocks interleaved with the user's text. The old single-block parser only
// ever looked at the FIRST block and left any later ones as literal text —
// which the generic XML notification parser below then picked up and
// rendered as a system-notification card. These functions replaced it.
//
// Wire format, one block per quote, written at the quote's position:
//   <reply_context>first quoted passage</reply_context>
//   my reply to the first
//   <reply_context>second quoted passage</reply_context>
//   my reply to the second
//
// `parseReplyContexts` replaces each block with a `quoteMarker(index)` —
// a pair of Unicode private-use characters wrapping the quote's index —
// so a later render pass (`splitAtQuoteMarkers`) can put each quote back
// at its exact position in the document. PUA characters are never typed
// by a user, are not whitespace, and are not valid XML tag characters, so
// they pass untouched through every other parser in this file.
//
// Written as the 4-hex-digit `\uXXXX` escape, never the brace form
// (`\u{XXXX}`): the brace form is only a code-point escape under the regex
// `u`/`v` flag. Without it, `\u{e000}` parses as the identity escape `u`
// followed by the literal text `{e000}` — verified directly: outside `u`
// mode, `/\u{e000}/.test('u{e000}')` is `true` and it never matches the
// real character. `\uE000` is a code-point escape in every mode, in both
// strings and regexes, so this stays correct under any transpiler.
// `QUOTE_MARKER_RE` is exported so a test can prove that by reconstructing
// it from `.source` with no flags and matching a real `quoteMarker()`.
const QUOTE_MARKER_OPEN = '\uE000';
const QUOTE_MARKER_CLOSE = '\uE001';
export const QUOTE_MARKER_RE = /\uE000(\d+)\uE001/g;

/** The exact marker `parseReplyContexts` writes in place of quote `index`. */
export function quoteMarker(index: number): string {
  return `${QUOTE_MARKER_OPEN}${index}${QUOTE_MARKER_CLOSE}`;
}

// Only `</reply_context>` is escaped — nothing else — so the body can never
// contain a literal closing tag, and `replyContextBlocks` below always stops
// at the real one.
function escapeReplyContextBody(quote: string): string {
  return quote.split('</reply_context>').join('&lt;/reply_context&gt;');
}

function unescapeReplyContextBody(body: string): string {
  return body.split('&lt;/reply_context&gt;').join('</reply_context>');
}

/** One `<reply_context>` block, serialized for the wire. Escapes `</reply_context>`. */
export function serializeReplyContext(quote: string): string {
  return `<reply_context>${escapeReplyContextBody(quote)}</reply_context>`;
}

const REPLY_CONTEXT_OPEN = '<reply_context';
const REPLY_CONTEXT_CLOSE = '</reply_context>';
const NEWLINE = 10;
/** A regex `\w` without the `u` flag: `[A-Za-z0-9_]`. */
const WORD_CHAR = /\w/;

/**
 * Every `<reply_context …>…</reply_context>` block in `text`, in order, as the
 * regex `/<reply_context\b[^>]*>([\s\S]*?)<\/reply_context>\n?/g` matched
 * them — the same spans at the same indices — in linear time.
 *
 * - The open tag tolerates attributes and whitespace (`<reply_context a="x" >`),
 *   but the name must end there: `<reply_contextx>` is not a block.
 * - Each block ends at the first `</reply_context>` after its open tag.
 * - One `\n` right after the close tag goes with the block, so a block on its
 *   own line does not leave a blank line behind. A leading newline stays: it
 *   separates the block from the text before it.
 * - An unclosed block matches nothing and stays in the text.
 *
 * WHY NOT THE REGEX. Its lazy body re-scanned the rest of the message for
 * every opener that never closed: `'<reply_context>'.repeat(16_000)` (240k
 * characters) took ~1 s with Bun, in every viewer's tab, on every render.
 * `tagBlocks` from `@kortix/shared` cannot stand in: its `attributes: 'any'`
 * accepts `<reply_contextx>` as an opener, which pairs a different closer.
 * This scanner reads each character a bounded number of times, the way
 * `tagBlocks` does: every search starts where the previous one stopped, and
 * the scan stops once a `>` or a closer is absent from the rest of the text,
 * because then no later opener can close either.
 */
function replyContextBlocks(text: string): TagBlock[] {
  const blocks: TagBlock[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(REPLY_CONTEXT_OPEN, from);
    if (index === -1) return blocks;
    const after = index + REPLY_CONTEXT_OPEN.length;
    // `\b`: the name ends in a word character, so the next one must not be.
    if (after < text.length && WORD_CHAR.test(text[after]!)) {
      from = after;
      continue;
    }
    const gt = text.indexOf('>', after);
    if (gt === -1) return blocks;
    const closeAt = text.indexOf(REPLY_CONTEXT_CLOSE, gt + 1);
    if (closeAt === -1) return blocks;
    let end = closeAt + REPLY_CONTEXT_CLOSE.length;
    if (text.charCodeAt(end) === NEWLINE) end += 1;
    blocks.push({ index, end, attrs: text.slice(after, gt), body: text.slice(gt + 1, closeAt) });
    from = end;
  }
}

/**
 * Every `<reply_context>` block in `text`, in order.
 * `cleanText` has each block replaced by a quote marker (see below) so a later
 * render can put the quote back at its position; one newline directly after a
 * block is consumed with it. Result is trimmed.
 */
export function parseReplyContexts(text: string): { cleanText: string; quotes: string[] } {
  const quotes: string[] = [];
  const cleanText = replaceSpans(text, replyContextBlocks(text), (block) => {
    const index = quotes.length;
    quotes.push(unescapeReplyContextBody(block.body).trim());
    return quoteMarker(index);
  }).trim();
  return { cleanText, quotes };
}

/** `text` with every `<reply_context>` block removed; blank-line runs collapsed; trimmed. */
export function stripReplyContexts(text: string): string {
  return removeSpans(text, replyContextBlocks(text))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * `text` without its leading and trailing `\n`, as
 * `text.replace(/^\n+/, '').replace(/\n+$/, '')` returned it, in one pass.
 * `/\n+$/` retried every newline of a blank run that did not reach the end,
 * so a long blank run between two words took seconds.
 */
function trimNewlines(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 10) start++;
  while (end > start && text.charCodeAt(end - 1) === 10) end--;
  return text.slice(start, end);
}

/**
 * Split text produced by `parseReplyContexts` back into ordered pieces.
 * Text pieces are trimmed of leading/trailing newlines; empty text pieces dropped.
 */
export function splitAtQuoteMarkers(
  text: string,
  quotes: readonly string[],
): Array<{ kind: 'text'; text: string } | { kind: 'quote'; text: string; index: number }> {
  const pieces: Array<
    { kind: 'text'; text: string } | { kind: 'quote'; text: string; index: number }
  > = [];
  // Invariant: `text` and `quotes` are the paired output of one
  // `parseReplyContexts` call, so every marker's index is a valid index
  // into `quotes`. `quotes[index] ?? ''` still guards it: if a caller ever
  // passes a mismatched pair, an out-of-range marker degrades to an empty
  // quote instead of throwing, so one bad quote can't take down the whole
  // render.
  const re = new RegExp(QUOTE_MARKER_RE);
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const before = trimNewlines(text.slice(cursor, match.index));
    if (before) pieces.push({ kind: 'text', text: before });
    const index = Number(match[1]);
    pieces.push({ kind: 'quote', text: quotes[index] ?? '', index });
    cursor = re.lastIndex;
  }
  const rest = trimNewlines(text.slice(cursor));
  if (rest) pieces.push({ kind: 'text', text: rest });
  return pieces;
}
