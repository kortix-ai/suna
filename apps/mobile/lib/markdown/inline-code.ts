/**
 * What an inline code span in a message IS, decided from its text alone.
 * Mirrors `apps/web/src/components/markdown/code/inline-chip.tsx`
 * (`isHexColor`) and `unified-markdown-utils.ts` (`looksLikeUrl`,
 * `looksLikeFilePath`).
 */

/**
 * The four CSS hex forms and nothing else: `#RGB`, `#RGBA`, `#RRGGBB`,
 * `#RRGGBBAA`. Anchored at both ends — a swatch claims the whole token IS a
 * colour.
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(text: string): boolean {
  return HEX_COLOR.test(text);
}

/** A URL with a scheme and no whitespace. */
export function looksLikeUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text);
}

const FILE_EXTENSION = /\.\w{1,10}$/;
const COMMON_NON_FILES = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'v1.', 'v2.']);

/** A path worth opening: has a slash, ends in an extension, no spaces, not a URL. */
export function looksLikeFilePath(text: string): boolean {
  if (!text || text.length < 3 || text.length > 300) return false;
  if (text.includes(' ') || text.includes('\n')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (COMMON_NON_FILES.has(text.toLowerCase())) return false;
  if (!text.includes('/')) return false;
  return FILE_EXTENSION.test(text);
}

export type InlineCodeKind = 'hex' | 'url' | 'path' | 'plain';

/** Hex first (a hex is neither a URL nor a path), then URL, then path. */
export function classifyInlineCode(raw: string): InlineCodeKind {
  const text = raw.trim();
  if (isHexColor(text)) return 'hex';
  if (looksLikeUrl(text)) return 'url';
  if (looksLikeFilePath(text)) return 'path';
  return 'plain';
}

/**
 * How `splitInlineCode` cuts a long span, in characters.
 *
 * - `splitAbove`: a span this long or shorter stays one chip. At the chip's
 *   7.39px per character that is at most ~131px, about one long prose word.
 * - `max`: no piece is longer. 20 characters are ~161px with padding and
 *   border, which fits a 240px table column and a list nested three deep on a
 *   320pt screen (`markdown-layout.test.ts`).
 * - `merge`: neighbouring pieces whose joint length stays within this are
 *   drawn as one chip. Fewer native views, and a one-character piece never
 *   wraps onto a line alone.
 */
export const INLINE_CODE_SEGMENT = { splitAbove: 16, max: 20, merge: 10 } as const;

const WORD_CHAR = /[a-z0-9]/i;
const WHITESPACE = /\s/;
const SEPARATORS = new Set(['/', '\\', '?', '&', '=', ',']);

/**
 * A preferred break AFTER `code[i]`:
 * - after a run of whitespace;
 * - after a run of `/ \ ? & = ,` (so `https://` stays whole);
 * - after a hyphen between two word characters (`user-message`, not `--flag`).
 */
function breaksAfter(code: string, i: number): boolean {
  const char = code[i];
  const next = code[i + 1];
  if (next === undefined) return false;
  if (WHITESPACE.test(char)) return !WHITESPACE.test(next);
  if (SEPARATORS.has(char)) return !SEPARATORS.has(next);
  if (char === '-') return i > 0 && WORD_CHAR.test(code[i - 1]) && WORD_CHAR.test(next);
  return false;
}

/** Cuts `text` after every index where `shouldBreak` holds. */
function cutWhere(text: string, shouldBreak: (i: number) => boolean): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (shouldBreak(i)) {
      pieces.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

/** Joins neighbours while the joined piece stays within `limit`. */
function pack(pieces: string[], limit: number): string[] {
  const packed: string[] = [];
  for (const piece of pieces) {
    const last = packed.length - 1;
    if (last >= 0 && packed[last].length + piece.length <= limit) packed[last] += piece;
    else packed.push(piece);
  }
  return packed;
}

/** A piece longer than `max`: cut after `.` `_` `:`, then into fixed chunks. */
function shorten(piece: string, max: number): string[] {
  if (piece.length <= max) return [piece];
  const secondary = pack(
    cutWhere(piece, (i) => ['.', '_', ':'].includes(piece[i]) && i < piece.length - 1),
    max,
  );
  return secondary.flatMap((part) => {
    if (part.length <= max) return [part];
    const chunks: string[] = [];
    for (let i = 0; i < part.length; i += max) chunks.push(part.slice(i, i + max));
    return chunks;
  });
}

/**
 * The inline code chip is an inline `View`, and an inline view never wraps.
 * A long span is therefore drawn as several chips side by side, cut where web
 * would break the line: after spaces, slashes, and word hyphens first; after
 * dots, underscores, and colons only inside a piece still longer than
 * `INLINE_CODE_SEGMENT.max`; then at fixed lengths.
 *
 * Lossless: `splitInlineCode(code).join('') === code`, and no piece is empty.
 */
export function splitInlineCode(code: string): string[] {
  if (code.length <= INLINE_CODE_SEGMENT.splitAbove) return [code];
  const pieces = cutWhere(code, (i) => breaksAfter(code, i)).flatMap((piece) =>
    shorten(piece, INLINE_CODE_SEGMENT.max),
  );
  return pack(pieces, INLINE_CODE_SEGMENT.merge);
}
