/**
 * Metrics of the chat markdown renderer, transcribed from web's
 * `apps/web/src/components/markdown/unified-markdown.tsx` and
 * `code/code-block.tsx` so a message looks the same on both.
 *
 * The app elsewhere uses stock Tailwind spacing (CLAUDE.md, Color rule 2).
 * Markdown is the exception: the goal is web's exact look, so every value here
 * is web's class converted at web's scale — `--spacing: 0.23rem` = 3.68px per
 * step, `--radius: 0.625rem` — and written as a number, because
 * react-native-markdown-display takes style objects, not classes.
 */

/** One Tailwind spacing step on web, in px. */
export const WEB_SPACING_STEP = 3.68;

/** `web(5)` = the px of web's `*-5`. */
export function web(steps: number): number {
  return Math.round(steps * WEB_SPACING_STEP * 100) / 100;
}

/** Web type ramp (`app/globals.css` `--text-*`), [fontSize, lineHeight]. */
export const TYPE = {
  /**
   * Chat prose. Web's `.kortix-markdown` root is `text-[15px]`; mobile reads
   * one step up at 16px (Jay, 2026-09-22), `leading-relaxed` (1.625) = 26.
   */
  body: { fontSize: 16, lineHeight: 26 },
  xs: { fontSize: 13, lineHeight: 16 },
  sm: { fontSize: 14, lineHeight: 20 },
  base: { fontSize: 16, lineHeight: 24 },
  lg: { fontSize: 18, lineHeight: 28 },
  xl: { fontSize: 20, lineHeight: 28 },
} as const;

/** Web radii: `rounded-sm` 6, `rounded-md` 8, `rounded-lg` 10. */
export const RADIUS = { sm: 6, md: 8, lg: 10, inlineCode: 5, swatch: 3 } as const;

/** Code block (web `code-block.tsx`). */
export const CODE_BLOCK = {
  captionMinHeight: 29.5,
  captionPaddingX: web(2),
  captionPaddingY: web(0.5),
  captionFontSize: 12,
  /** `tracking-wide` = 0.025em. */
  captionLetterSpacing: 0.3,
  bodyMaxHeight: 520,
  bodyPaddingX: web(4),
  bodyPaddingY: web(2.5),
  fontSize: TYPE.xs.fontSize,
  lineHeight: Math.round(TYPE.xs.fontSize * 1.65 * 100) / 100,
  /** `tracking-tight` = -0.025em. */
  letterSpacing: -0.33,
  copyButtonSize: web(7),
  copyIconSize: web(4),
  /** Web resets the copy icon 2000 ms after a copy. */
  copiedResetMs: 2000,
} as const;

/**
 * Code font metrics, read from `assets/font/Roobert/RoobertMono-Regular.ttf`
 * (`MONO_FONT_FAMILY`, the same face on iOS and Android): unitsPerEm 1000,
 * hhea ascent 1018, descent 246, line gap 0, advance 630.
 */
const MONO = { unitsPerEm: 1000, ascent: 1018, descent: 246, advance: 630 } as const;

const CHIP_FONT_SIZE = 12.8;
const CHIP_LINE_HEIGHT = 15;
const CHIP_PADDING_Y = 1;
const CHIP_BORDER = 1;
/** Glyph content box of the code font at the chip size: 16.18px (taller than the 15px line). */
const CHIP_CONTENT = ((MONO.ascent + MONO.descent) / MONO.unitsPerEm) * CHIP_FONT_SIZE;
/** Chip text baseline above the bottom of its 15px line: half-leading (-0.59) + descent (3.15) = 2.56px. */
const CHIP_TEXT_BASELINE =
  (CHIP_LINE_HEIGHT - CHIP_CONTENT) / 2 + (MONO.descent / MONO.unitsPerEm) * CHIP_FONT_SIZE;

/**
 * Inline code chip — web `INLINE_CODE`:
 * `rounded-[5px] border px-1.5 py-[0.08rem] text-[0.8rem] tracking-tight`.
 * `0.8rem` is of web's 16px root, so 12.8px, not 0.8 × the 15px body.
 * Placement on the sentence baseline is `inlineCodeAnchor`.
 */
export const INLINE_CODE = {
  fontSize: CHIP_FONT_SIZE,
  lineHeight: CHIP_LINE_HEIGHT,
  /** `tracking-tight` = -0.025em. */
  letterSpacing: -0.32,
  paddingX: web(1.5),
  /** `py-[0.08rem]` = 1.28px, rounded to 1 to keep the chip inside a 20px table line. */
  paddingY: CHIP_PADDING_Y,
  borderWidth: CHIP_BORDER,
  /** 15 + 2 × 1 + 2 × 1 = 19px. */
  height: CHIP_LINE_HEIGHT + 2 * CHIP_PADDING_Y + 2 * CHIP_BORDER,
  /** Chip text baseline above the bottom of the chip's 15px text line: 2.56px. */
  textBaselineFromBottom: CHIP_TEXT_BASELINE,
  /** Chip text baseline above the chip's bottom border edge: 2.56 + 1 + 1 = 4.56px. */
  chipBaselineFromBottom: CHIP_TEXT_BASELINE + CHIP_PADDING_Y + CHIP_BORDER,
  /** One code character, px: Roobert Mono advance 8.06 + tracking -0.32 = 7.74. */
  charWidth: (MONO.advance / MONO.unitsPerEm) * CHIP_FONT_SIZE - 0.32,
  /** Hex swatch `size-[0.8em]`. */
  swatchSize: 10.24,
  swatchGap: web(1),
} as const;

/** Roobert (all weights), from the app's TTFs: unitsPerEm 1000, hhea ascent 1018, descent 246, line gap 0. */
const ROOBERT = { ascent: 1.018, descent: 0.246 } as const;

/**
 * iOS gives an inline view's text fragment no font, and NSTextStorage fills
 * in Helvetica 12, whose descender is 2.76px (measured with NSLayoutManager).
 */
const IOS_ATTACHMENT_DESCENDER = 2.76;

/**
 * Where the inline code view goes in its line.
 *
 * The inline view is the WHOLE chip (`height`, 19px at 1x text size). An
 * earlier version made the view only the part above the chip's text baseline
 * and let the rest hang out of its bottom; Android clips children to their
 * parent's bounds, so the bottom 5.07px (Menlo metrics) disappeared (about 70% of the chip
 * showed). Nothing may render outside this view.
 *
 * `translateY` moves the chip so its text baseline sits on the sentence
 * baseline. Where each platform puts the view's bottom edge:
 * - Android: on the line baseline (`TextLayoutManager.kt`:
 *   `getLineBaseline(line) - placeholderHeight`). Shift down by the chip's own
 *   baseline offset (4.56px). The paragraph's fixed line height leaves room
 *   below the baseline (body: 24.38px line, about 5.9px below the baseline).
 * - iOS: `RCTTextLayoutManager.mm` sets the bottom to the line fragment's
 *   bottom plus the fragment font's descender. The glyph rect of an
 *   attachment is the whole line fragment, and the font is Helvetica 12.
 *   That bottom sits `Roobert descent + half-leading - 2.76` above the line
 *   baseline, so the shift is the chip baseline offset minus that drop:
 *   +0.50px in body text, +2.72px in table cells.
 */
export function inlineCodeAnchor(
  os: string,
  line: { fontSize?: number; lineHeight?: number },
  fontScale = 1,
): { height: number; translateY: number } {
  const edges = CHIP_PADDING_Y + CHIP_BORDER;
  // The whole chip: text line + padding + border on both sides.
  const height = CHIP_LINE_HEIGHT * fontScale + 2 * edges;
  // Chip text baseline above the chip's bottom edge.
  const chipBaseline = CHIP_TEXT_BASELINE * fontScale + edges;
  if (os !== 'ios') return { height, translateY: chipBaseline };

  const fontSize = (line.fontSize ?? TYPE.body.fontSize) * fontScale;
  const fontLineHeight = (ROOBERT.ascent + ROOBERT.descent) * fontSize;
  const lineHeight = line.lineHeight === undefined ? fontLineHeight : line.lineHeight * fontScale;
  const halfLeading = Math.max(0, (lineHeight - fontLineHeight) / 2);
  const drop = ROOBERT.descent * fontSize + halfLeading - IOS_ATTACHMENT_DESCENDER;
  return { height, translateY: chipBaseline - drop };
}

/** Top-level markdown constructs whose vertical margins differ on web. */
export type BlockKind =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'list'
  | 'blockquote'
  | 'table'
  | 'hr'
  | 'code'
  | 'math';

/** Web's margins per construct, in px. */
export const BLOCK_MARGINS: Record<BlockKind, { top: number; bottom: number }> = {
  paragraph: { top: web(4), bottom: web(4) },
  heading1: { top: web(10), bottom: web(4) },
  heading2: { top: web(8), bottom: web(3) },
  heading3: { top: web(6), bottom: web(2) },
  heading4: { top: web(6), bottom: web(2) },
  heading5: { top: web(4), bottom: web(1) },
  heading6: { top: web(4), bottom: web(1) },
  list: { top: web(4), bottom: web(4) },
  blockquote: { top: web(5), bottom: web(5) },
  table: { top: web(5), bottom: web(5) },
  hr: { top: web(6), bottom: web(6) },
  code: { top: web(5), bottom: web(5) },
  /** `$$` display math: KaTeX's `.katex-display { margin: 1em 0 }` at the body size. */
  math: { top: TYPE.body.fontSize, bottom: TYPE.body.fontSize },
};

/**
 * Where a construct sits changes its paragraph margins on web:
 * `ul/ol [&_p]:mb-2` and `blockquote [&>p]:my-2`.
 */
export type StackContext = 'root' | 'list' | 'blockquote';

export function marginsFor(kind: BlockKind, context: StackContext): { top: number; bottom: number } {
  if (kind === 'paragraph' && context === 'list') return { top: web(4), bottom: web(2) };
  if (kind === 'paragraph' && context === 'blockquote') return { top: web(2), bottom: web(2) };
  return BLOCK_MARGINS[kind];
}

/**
 * The space between two stacked constructs. CSS collapses adjacent vertical
 * margins to the larger one; React Native adds them, which would double every
 * paragraph gap. The first construct in a container gets no top margin
 * (`first:mt-0`), so `previous === null` returns 0.
 */
export function collapsedGap(
  previous: BlockKind | null,
  next: BlockKind,
  context: StackContext = 'root',
): number {
  if (previous === null) return 0;
  return Math.max(marginsFor(previous, context).bottom, marginsFor(next, context).top);
}

/** react-native-markdown-display AST node type → construct, or null for inline/unknown nodes. */
export function kindOfNode(type: string): BlockKind | null {
  switch (type) {
    case 'paragraph':
      return 'paragraph';
    case 'heading1':
    case 'heading2':
    case 'heading3':
    case 'heading4':
    case 'heading5':
    case 'heading6':
      return type;
    case 'bullet_list':
    case 'ordered_list':
      return 'list';
    case 'blockquote':
      return 'blockquote';
    case 'table':
      return 'table';
    case 'hr':
      return 'hr';
    case 'fence':
    case 'code_block':
      return 'code';
    case 'math_block':
      return 'math';
    default:
      return null;
  }
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const BLOCKQUOTE = /^ {0,3}>/;
const TABLE_ROW = /^ {0,3}\|/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const INDENTED = /^(?: {4}|\t)/;
/** A display-math delimiter line (math-plugin.ts `mathBlock`): 2+ dollars, no other dollar. */
const MATH_LINE = /^ {0,3}\${2,}[^$]*$/;

function kindOfLine(line: string): BlockKind {
  const heading = HEADING.exec(line);
  if (heading) return `heading${heading[1].length}` as BlockKind;
  if (FENCE_LINE.test(line) || INDENTED.test(line)) return 'code';
  if (MATH_LINE.test(line)) return 'math';
  if (RULE.test(line)) return 'hr';
  if (LIST_ITEM.test(line)) return 'list';
  if (BLOCKQUOTE.test(line)) return 'blockquote';
  if (TABLE_ROW.test(line)) return 'table';
  return 'paragraph';
}

/**
 * The first and last construct of one `splitMarkdownBlocks` block, read from
 * its first and last lines — enough to collapse the margin BETWEEN blocks.
 * Margins between constructs INSIDE a block come from the parsed AST instead.
 */
export function classifyBlock(block: string): { first: BlockKind; last: BlockKind } {
  const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { first: 'paragraph', last: 'paragraph' };
  const first = kindOfLine(lines[0]);
  if (lines.length === 1) return { first, last: first };

  const lastLine = lines[lines.length - 1];
  let last = kindOfLine(lastLine);
  // An indented or lazy last line belongs to the construct the block opened.
  if (last === 'code' && !FENCE_LINE.test(lastLine) && (first === 'list' || first === 'blockquote')) {
    last = first;
  }
  if (last === 'paragraph' && (first === 'list' || first === 'blockquote' || first === 'code' || first === 'math')) {
    last = first;
  }
  return { first, last };
}

/**
 * Inline-start gutter of an ordered list, px: web's `pl-6` plus 1ch per digit
 * beyond the first (`ordered-list.tsx`). Roobert's `0` advance is 0.632em.
 */
export function orderedListGutter(itemCount: number, start = 1): number {
  const count = Math.max(itemCount, 1);
  const digits = Math.max(String(start).length, String(start + count - 1).length);
  return web(6) + Math.max(digits - 1, 0) * 0.632 * TYPE.body.fontSize;
}
