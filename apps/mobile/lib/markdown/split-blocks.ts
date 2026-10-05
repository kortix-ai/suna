/**
 * Splits markdown into top-level blocks that render the same one at a time as
 * they do together.
 *
 * The chat renderer parses each block in its own memoized component. While a
 * message streams, only the last block's string changes, so earlier blocks are
 * neither re-parsed nor remounted.
 *
 * A split happens only at a blank line outside fenced code and display math
 * (`$$` … `$$`, the markdown-it math rule in `math-plugin.ts`), and not when the
 * next line continues the current construct: an indented line (list item
 * content, indented code), another item of a list, or another blockquote.
 * Merging too much only costs speed; splitting wrongly changes the rendering,
 * so every rule here errs towards merging.
 *
 * Rule lines (---, ***, ___) outside fences become their own block, so the
 * renderer can draw them as separators, the same as before blocks existed.
 *
 * Every pattern is linear: line prefixes are scanned by hand, and no regex
 * nests quantifiers.
 */

import { PrefixCache } from './prefix-cache';

const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
// Display math opens on 2+ dollars with no other dollar on the line, and closes
// on a line of at least as many dollars (math-plugin.ts `mathBlock`).
const MATH_OPEN = /^(\${2,})([^$]*)$/;
const MATH_CLOSE = /^(\${2,})[ \t]*$/;
const BLANK_LINE = /^[ \t]*$/;
const INDENTED_LINE = /^[ \t]/;
const LIST_ITEM = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const BLOCKQUOTE = /^ {0,3}>/;
const SEPARATOR_LINE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
// A link reference definition resolves links in every other block, so text
// that has one is kept whole. The pattern over-matches on purpose: any mix of
// indentation, blockquote markers, and list markers before the label, and a
// label of up to 999 characters that may contain escapes and line breaks.
// Each prefix repetition starts with a non-space token and the label
// alternatives are disjoint, so matching stays linear.
const REFERENCE_DEFINITION =
  /^[ \t]*(?:(?:>|[*+-]|\d{1,9}[.)])[ \t]*)*\[(?:[^\]\\]|\\[\s\S]){1,999}\]:/m;

interface LinePrefix {
  /** Blockquote markers before the content. */
  quotes: number;
  /** Column after the last blockquote marker and its optional space. */
  quoteColumn: number;
  /** Column of the first content character. */
  column: number;
  /** Index of the first content character. */
  index: number;
  listMarker: boolean;
}

interface OpenFence {
  /** '`' or '~' for fenced code, '$' for display math. */
  marker: string;
  length: number;
  quotes: number;
  quoteColumn: number;
  column: number;
  /** The list item's content column when the opener line starts the item; null when unknown. */
  contentColumn: number | null;
  /**
   * The opener is indented 4+ columns with no list marker on its line. It is a
   * fence only inside a list item; otherwise it is indented code or paragraph
   * text, and a shallower fence line would open a real fence. Only a closer at
   * the same column ends it, so an uncertain opener can only merge more.
   */
  closesAtOwnColumnOnly: boolean;
}

export function isMarkdownSeparatorBlock(block: string): boolean {
  return SEPARATOR_LINE.test(block) && leadingColumns(block) <= 3;
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function scanPrefix(line: string, withListMarkers: boolean): LinePrefix {
  let index = 0;
  let column = 0;
  let quotes = 0;
  let quoteColumn = 0;
  let listMarker = false;

  for (;;) {
    while (line[index] === ' ' || line[index] === '\t') {
      column += line[index] === '\t' ? 4 - (column % 4) : 1;
      index += 1;
    }

    if (line[index] === '>') {
      quotes += 1;
      index += 1;
      column += 1;
      if (line[index] === ' ') {
        index += 1;
        column += 1;
      }
      quoteColumn = column;
      continue;
    }

    if (!withListMarkers) break;

    let end = index;
    if (line[index] === '*' || line[index] === '+' || line[index] === '-') {
      end = index + 1;
    } else {
      while (isDigit(line[end]) && end - index < 9) end += 1;
      if (end === index || (line[end] !== '.' && line[end] !== ')')) break;
      end += 1;
    }
    if (line[end] !== ' ' && line[end] !== '\t') break;

    column += end - index;
    index = end;
    listMarker = true;
  }

  return { quotes, quoteColumn, column, index, listMarker };
}

function openFence(line: string): OpenFence | null {
  const prefix = scanPrefix(line, true);
  const rest = line.slice(prefix.index);
  const match = FENCE_OPEN.exec(rest) ?? MATH_OPEN.exec(rest);
  if (!match) return null;
  const [, fence, info] = match;
  if (fence[0] === '`' && info.includes('`')) return null;
  return {
    marker: fence[0],
    length: fence.length,
    quotes: prefix.quotes,
    quoteColumn: prefix.quoteColumn,
    column: prefix.column,
    contentColumn: prefix.listMarker ? prefix.column : null,
    closesAtOwnColumnOnly: !prefix.listMarker && prefix.column - prefix.quoteColumn >= 4,
  };
}

type FenceLine = 'content' | 'close' | 'exit';

/**
 * Classifies a line inside an open fence. 'exit' means the line leaves the
 * fence's container (a blockquote or list item), which ends the fence without
 * consuming the line.
 */
function classifyFenceLine(line: string, fence: OpenFence): FenceLine {
  const prefix = scanPrefix(line, false);
  const rest = line.slice(prefix.index);

  if (prefix.quotes < fence.quotes) return 'exit';
  if (fence.contentColumn !== null && rest !== '' && prefix.column < fence.contentColumn) return 'exit';

  const close = (fence.marker === '$' ? MATH_CLOSE : FENCE_CLOSE).exec(rest);
  if (!close || prefix.quotes !== fence.quotes) return 'content';
  if (close[1][0] !== fence.marker || close[1].length < fence.length) return 'content';

  let closes: boolean;
  if (fence.closesAtOwnColumnOnly) closes = prefix.column === fence.column;
  else if (fence.contentColumn !== null) closes = prefix.column - fence.contentColumn <= 3;
  else closes = prefix.column - fence.quoteColumn <= 3;
  return closes ? 'close' : 'content';
}

/**
 * A rule line is a separator block only when it cannot belong to a list item:
 * indented at most 3 columns, and unindented when the current block has a list.
 * An indented rule under a list item is item content (a rule or a setext
 * underline), and a rule indented 4+ columns is code or paragraph text.
 */
function isSeparatorOutsideList(line: string, blockHasList: boolean): boolean {
  if (!SEPARATOR_LINE.test(line)) return false;
  const column = leadingColumns(line);
  return column <= 3 && (column === 0 || !blockHasList);
}

function leadingColumns(line: string): number {
  let column = 0;
  for (let index = 0; line[index] === ' ' || line[index] === '\t'; index += 1) {
    column += line[index] === '\t' ? 4 - (column % 4) : 1;
  }
  return column;
}

export interface MarkdownBlocks {
  blocks: string[];
  /**
   * The text ends inside a fenced code block that has no closing fence yet —
   * while a message streams, the last block's code is still growing. The
   * renderer holds syntax highlighting for that fence until it closes.
   */
  endsInOpenFence: boolean;
}

export function splitMarkdownBlocks(text: string): string[] {
  return splitMarkdown(text).blocks;
}

/**
 * `cache` holds scan states of earlier texts (`SCAN_STATES`); `null` scans
 * from the start. Either way the result is the same.
 */
export function splitMarkdown(text: string, cache: PrefixCache<ScanState> | null = SCAN_STATES): MarkdownBlocks {
  const scanned = scanBlocks(text, cache);
  // Intentional: a message with a reference definition is one block, so it
  // also renders its rule lines with the markdown hr style, not as separators.
  if (REFERENCE_DEFINITION.test(text)) return { blocks: [text], endsInOpenFence: scanned.endsInOpenFence };
  return scanned;
}

export interface ScanState {
  blocks: string[];
  blockStart: number;
  blockEnd: number;
  blockHasList: boolean;
  blockHasQuote: boolean;
  blankSinceContent: boolean;
  fence: OpenFence | null;
}

/**
 * Scan states at the start of a text's last line, keyed by the text before
 * that line. The scan reads one line at a time, and its state at a line start
 * depends only on the lines before it. A text that starts with a saved prefix
 * (a streaming message one tick later) resumes there, so each tick scans only
 * its last lines.
 */
const SCAN_STATES = new PrefixCache<ScanState>();

function scanBlocks(text: string, cache: PrefixCache<ScanState> | null): MarkdownBlocks {
  const lastLineStart = text.lastIndexOf('\n') + 1;
  const resume = cache?.find(text);
  const blocks = resume ? resume.value.blocks.slice() : [];
  let blockStart = resume?.value.blockStart ?? -1;
  let blockEnd = resume?.value.blockEnd ?? -1;
  let blockHasList = resume?.value.blockHasList ?? false;
  let blockHasQuote = resume?.value.blockHasQuote ?? false;
  let blankSinceContent = resume?.value.blankSinceContent ?? false;
  let fence: OpenFence | null = resume?.value.fence ?? null;

  const flush = () => {
    if (blockStart >= 0) blocks.push(text.slice(blockStart, blockEnd));
    blockStart = -1;
    blockHasList = false;
    blockHasQuote = false;
    blankSinceContent = false;
  };

  let lineStart = resume ? resume.prefix.length : 0;
  // Save a state only when new complete lines arrived: a tick inside the same
  // line resumes from the saved one and copies no prefix.
  const saveAt = lastLineStart > lineStart ? lastLineStart : -1;
  while (lineStart <= text.length) {
    if (cache && lineStart === saveAt) {
      cache.set(text.slice(0, lineStart), {
        blocks: blocks.slice(),
        blockStart,
        blockEnd,
        blockHasList,
        blockHasQuote,
        blankSinceContent,
        fence,
      });
    }
    const newline = text.indexOf('\n', lineStart);
    const next = newline === -1 ? text.length + 1 : newline + 1;
    let lineEnd = newline === -1 ? text.length : newline;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    const line = text.slice(lineStart, lineEnd);

    if (fence) {
      const kind = classifyFenceLine(line, fence);
      if (kind === 'exit') {
        fence = null;
      } else {
        blockEnd = lineEnd;
        if (kind === 'close') fence = null;
        lineStart = next;
        continue;
      }
    }

    if (BLANK_LINE.test(line)) {
      if (blockStart >= 0) blankSinceContent = true;
    } else if (isSeparatorOutsideList(line, blockHasList)) {
      flush();
      blocks.push(line);
    } else {
      if (blockStart >= 0 && blankSinceContent) {
        const continues =
          INDENTED_LINE.test(line) ||
          (blockHasList && LIST_ITEM.test(line)) ||
          (blockHasQuote && BLOCKQUOTE.test(line));
        if (!continues) flush();
      }
      if (blockStart < 0) blockStart = lineStart;
      blockEnd = lineEnd;
      blankSinceContent = false;
      if (LIST_ITEM.test(line)) blockHasList = true;
      if (BLOCKQUOTE.test(line)) blockHasQuote = true;
      fence = openFence(line);
    }

    lineStart = next;
  }

  flush();
  return { blocks, endsInOpenFence: fence !== null && fence.marker !== '$' };
}
