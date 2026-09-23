import { describe, expect, test } from 'bun:test';

import {
  classifyBlock,
  CODE_BLOCK,
  INLINE_CODE,
  inlineCodeAnchor,
  collapsedGap,
  kindOfNode,
  orderedListGutter,
  RADIUS,
  TYPE,
  web,
} from './markdown-layout';
import { INLINE_CODE_SEGMENT } from './inline-code';

describe('web scale', () => {
  test('one step is 0.23rem = 3.68px', () => {
    expect(web(4)).toBe(14.72);
    expect(web(5)).toBe(18.4);
    expect(web(0.5)).toBe(1.84);
  });

  test('code block body is text-xs at leading 1.65', () => {
    expect(CODE_BLOCK.fontSize).toBe(13);
    expect(CODE_BLOCK.lineHeight).toBe(21.45);
    expect(CODE_BLOCK.bodyPaddingX).toBe(14.72);
    expect(CODE_BLOCK.bodyPaddingY).toBe(9.2);
  });
});

describe('collapsedGap', () => {
  test('uses the larger margin like CSS, not the sum', () => {
    expect(collapsedGap('paragraph', 'paragraph')).toBe(14.72);
    expect(collapsedGap('paragraph', 'heading2')).toBe(29.44);
    expect(collapsedGap('heading2', 'paragraph')).toBe(14.72);
    expect(collapsedGap('paragraph', 'code')).toBe(18.4);
    expect(collapsedGap('code', 'hr')).toBe(22.08);
  });

  test('the first construct has no top margin', () => {
    expect(collapsedGap(null, 'heading1')).toBe(0);
  });

  test('list and blockquote paragraphs use web mb-2 / my-2', () => {
    expect(collapsedGap('paragraph', 'paragraph', 'list')).toBe(14.72);
    expect(collapsedGap('paragraph', 'paragraph', 'blockquote')).toBe(7.36);
  });
});

describe('kindOfNode', () => {
  test('maps AST node types and ignores inline ones', () => {
    expect(kindOfNode('bullet_list')).toBe('list');
    expect(kindOfNode('ordered_list')).toBe('list');
    expect(kindOfNode('fence')).toBe('code');
    expect(kindOfNode('heading3')).toBe('heading3');
    expect(kindOfNode('textgroup')).toBeNull();
    expect(kindOfNode('math_block')).toBe('math');
    expect(kindOfNode('math_inline')).toBeNull();
  });

  test('display math has KaTeX .katex-display margin: 1em of the 16px body', () => {
    expect(collapsedGap('paragraph', 'math')).toBe(16);
    expect(collapsedGap('math', 'heading2')).toBe(web(8));
  });
});

describe('classifyBlock', () => {
  test('reads the first and last construct of a block', () => {
    expect(classifyBlock('## Title')).toEqual({ first: 'heading2', last: 'heading2' });
    expect(classifyBlock('```ts\nconst a = 1;\n```')).toEqual({ first: 'code', last: 'code' });
    expect(classifyBlock('- a\n\n  continued')).toEqual({ first: 'list', last: 'list' });
    expect(classifyBlock('> quote\nlazy')).toEqual({ first: 'blockquote', last: 'blockquote' });
    expect(classifyBlock('| a |\n| - |\n| 1 |')).toEqual({ first: 'table', last: 'table' });
    expect(classifyBlock('Intro\n```sh\nls\n```')).toEqual({ first: 'paragraph', last: 'code' });
    expect(classifyBlock('---')).toEqual({ first: 'hr', last: 'hr' });
    expect(classifyBlock('plain text')).toEqual({ first: 'paragraph', last: 'paragraph' });
    expect(classifyBlock('$$\n\\frac{a}{b}\n$$')).toEqual({ first: 'math', last: 'math' });
    expect(classifyBlock('$$\n\\frac{a}{b}')).toEqual({ first: 'math', last: 'math' });
    expect(classifyBlock('Text\n$$\nx\n$$')).toEqual({ first: 'paragraph', last: 'math' });
    expect(classifyBlock('$$x$$')).toEqual({ first: 'paragraph', last: 'paragraph' });
  });
});

describe('orderedListGutter', () => {
  test('pl-6 for one digit, plus 1ch per extra digit', () => {
    expect(orderedListGutter(9)).toBe(22.08);
    expect(orderedListGutter(10)).toBeCloseTo(22.08 + 10.112, 5);
    expect(orderedListGutter(3, 98)).toBeCloseTo(22.08 + 2 * 10.112, 5);
  });
});

describe('inline code chip', () => {
  test("matches web's INLINE_CODE class", () => {
    // rounded-[5px] border px-1.5 text-[0.8rem] tracking-tight
    expect(RADIUS.inlineCode).toBe(5);
    expect(INLINE_CODE.borderWidth).toBe(1);
    expect(INLINE_CODE.paddingX).toBe(web(1.5));
    expect(INLINE_CODE.fontSize).toBe(12.8);
    expect(INLINE_CODE.letterSpacing).toBe(-0.32);
  });

  test('is shorter than every line it sits in, so the line height does not move', () => {
    expect(INLINE_CODE.height).toBe(INLINE_CODE.lineHeight + 2 * INLINE_CODE.paddingY + 2 * INLINE_CODE.borderWidth);
    expect(INLINE_CODE.height).toBeLessThanOrEqual(TYPE.body.lineHeight);
    expect(INLINE_CODE.height).toBeLessThanOrEqual(TYPE.sm.lineHeight);
  });

  test('knows where its own text baseline sits', () => {
    // Roobert Mono Regular: unitsPerEm 1000, hhea ascent 1018, descent 246.
    const content = ((1018 + 246) / 1000) * 12.8;
    const descent = (246 / 1000) * 12.8;
    const textBaseline = (INLINE_CODE.lineHeight - content) / 2 + descent;
    expect(INLINE_CODE.textBaselineFromBottom).toBeCloseTo(textBaseline, 5);
    expect(INLINE_CODE.chipBaselineFromBottom).toBeCloseTo(textBaseline + INLINE_CODE.paddingY + INLINE_CODE.borderWidth, 5);
    expect(INLINE_CODE.chipBaselineFromBottom).toBeCloseTo(4.56, 2);
  });

  test('the widest piece fits a table cell and a nested list on a 320pt phone', () => {
    // Roobert Mono advance 630/1000 em, plus tracking-tight.
    expect(INLINE_CODE.charWidth).toBeCloseTo((630 / 1000) * 12.8 - 0.32, 5);
    const widest = INLINE_CODE_SEGMENT.max * INLINE_CODE.charWidth + 2 * INLINE_CODE.paddingX + 2 * INLINE_CODE.borderWidth;
    expect(widest).toBeLessThanOrEqual(240);
    expect(widest).toBeLessThanOrEqual(320 - 2 * 16 - 3 * web(6));
  });
});

describe('inlineCodeAnchor', () => {
  const body = { fontSize: TYPE.body.fontSize, lineHeight: TYPE.body.lineHeight };
  const table = { fontSize: TYPE.sm.fontSize, lineHeight: TYPE.sm.lineHeight };
  // Chip text baseline above the chip's bottom edge: 2.56 + 1 + 1.
  const hang = INLINE_CODE.chipBaselineFromBottom;

  test('the inline view is the whole chip, so nothing hangs outside it to be clipped', () => {
    // A view that holds only the part above the text baseline let Android clip
    // the bottom 5.07px: Jay saw about 70% of the chip (13.93 / 19).
    expect(inlineCodeAnchor('android', body).height).toBeCloseTo(INLINE_CODE.height, 5);
    expect(inlineCodeAnchor('android', body).height).toBeCloseTo(19, 5);
    expect(inlineCodeAnchor('ios', body).height).toBeCloseTo(19, 5);
    // Border and padding stay 4px; the text line scales with the system text size.
    expect(inlineCodeAnchor('android', body, 1.5).height).toBeCloseTo(
      1.5 * INLINE_CODE.lineHeight + 2 * INLINE_CODE.paddingY + 2 * INLINE_CODE.borderWidth,
      5,
    );
  });

  test('Android puts the view bottom on the baseline: shift down by the chip baseline', () => {
    expect(inlineCodeAnchor('android', body).translateY).toBeCloseTo(hang, 5);
    expect(inlineCodeAnchor('android', table).translateY).toBeCloseTo(hang, 5);
    expect(inlineCodeAnchor('android', body, 1.5).translateY).toBeCloseTo(
      1.5 * INLINE_CODE.textBaselineFromBottom + INLINE_CODE.paddingY + INLINE_CODE.borderWidth,
      5,
    );
  });

  test('iOS puts the view bottom on the line bottom minus a Helvetica 12 descender', () => {
    // Roobert: unitsPerEm 1000, hhea ascent 1018, descent 246. Helvetica 12 descender 2.76.
    // body: -(3.936 + (26 - 20.224) / 2 - 2.76) + 4.56 = 0.495
    expect(inlineCodeAnchor('ios', body).translateY).toBeCloseTo(-4.064 + hang, 2);
    // table: -(3.444 + (20 - 17.696) / 2 - 2.76) + 4.56 = 2.723
    expect(inlineCodeAnchor('ios', table).translateY).toBeCloseTo(-1.836 + hang, 2);
    // No line height: TextKit adds no half-leading.
    expect(inlineCodeAnchor('ios', { fontSize: 15 }).translateY).toBeCloseTo(-(3.69 - 2.76) + hang, 2);
  });
});
