/**
 * The `<reply_context>` wire format for reply quotes (COR-117), React-free.
 *
 * Lives outside `message-parsing.tsx` so the composer (serialize.ts,
 * quote-node.ts, composer-logic.ts) can import it without pulling that
 * module's React components into its graph.
 * `message-parsing.tsx` re-exports everything here, so its importers are
 * unchanged.
 */

// ── COR-117: N inline reply-context quotes ────────────────────────────
//
// The composer can insert more than one <reply_context> block into a single
// message, interleaved with the user's text. The old single-block parser only
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
// followed by the literal text `{e000}` \u2014 verified directly: outside `u`
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
// contain a literal closing tag, and the non-greedy match below always
// stops at the real one.
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

// Tolerates attributes on the open tag and surrounding whitespace inside it
// (`<reply_context foo="x" >`). Consumes one trailing newline with the block
// so a block on its own line doesn't leave a blank line behind; a leading
// newline is left alone so it stays as the separator for the text before it.
const REPLY_CONTEXT_BLOCK_RE = /<reply_context\b[^>]*>([\s\S]*?)<\/reply_context>\n?/g;

/**
 * Every `<reply_context>` block in `text`, in order.
 * `cleanText` has each block replaced by a quote marker (see below) so a later
 * render can put the quote back at its position; newlines directly around a
 * block are consumed with it. Result is trimmed.
 */
export function parseReplyContexts(text: string): { cleanText: string; quotes: string[] } {
  const quotes: string[] = [];
  const cleanText = text
    .replace(REPLY_CONTEXT_BLOCK_RE, (_full, rawBody: string) => {
      const index = quotes.length;
      quotes.push(unescapeReplyContextBody(rawBody).trim());
      return quoteMarker(index);
    })
    .trim();
  return { cleanText, quotes };
}

/** `text` with every `<reply_context>` block removed; blank-line runs collapsed; trimmed. */
export function stripReplyContexts(text: string): string {
  return text
    .replace(/<reply_context\b[^>]*>[\s\S]*?<\/reply_context>\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    const before = text.slice(cursor, match.index).replace(/^\n+/, '').replace(/\n+$/, '');
    if (before) pieces.push({ kind: 'text', text: before });
    const index = Number(match[1]);
    pieces.push({ kind: 'quote', text: quotes[index] ?? '', index });
    cursor = re.lastIndex;
  }
  const rest = text.slice(cursor).replace(/^\n+/, '').replace(/\n+$/, '');
  if (rest) pieces.push({ kind: 'text', text: rest });
  return pieces;
}

/**
 * Join two already-trimmed pieces of one message with ONE separator: a space,
 * or a newline where either side meets a `<reply_context>` block.
 *
 * Used where text is rejoined around a command chip (`serializeDocument`,
 * `planDraftSubmission`). A space there glued the block to the args —
 * `<reply_context>q</reply_context> run it` — so `$ARGUMENTS` lost the
 * quote's own line and the reloaded bubble drew a leading space after the
 * quote. The newline is the separator every other quote position already
 * gets from the block-level serializer. Empty pieces are dropped.
 */
export function joinAtQuoteBoundary(before: string, after: string): string {
  if (!before) return after;
  if (!after) return before;
  const atQuote = before.endsWith('</reply_context>') || after.startsWith('<reply_context');
  return `${before}${atQuote ? '\n' : ' '}${after}`;
}
