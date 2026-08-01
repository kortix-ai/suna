import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROJECT_GLYPH_GROUPS } from '@kortix/shared';
import { GlyphPicker } from './glyph-picker';

/**
 * Block and line comments stripped out, same as emoji-picker.test.tsx's own
 * `code` variable. glyph-picker.tsx's file-header docstring deliberately
 * names `size-8`, `px-1.5`, `grid-cols-9`, and `h-[368px]` in prose — reading
 * this instead of raw `source` is what stops a comment edit from ever
 * flipping the height check below, the way an earlier, unstripped version of
 * this same test once did.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('GlyphPicker', () => {
  test('renders every catalogue glyph', () => {
    const html = renderToStaticMarkup(
      <GlyphPicker color="blue" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    // One button per glyph. A grid that silently renders 60 of 64 would look fine.
    const buttons = html.match(/data-glyph="/g) ?? [];
    expect(buttons).toHaveLength(64);
  });

  test('renders a header for each of the 8 groups', () => {
    const html = renderToStaticMarkup(
      <GlyphPicker color="blue" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    for (const group of PROJECT_GLYPH_GROUPS) expect(html).toContain(group.label);
  });

  test('the whole grid paints in the selected colour', () => {
    // The grid is the preview. If cells did not follow the colour row, the user
    // would only discover the colour after committing.
    const html = renderToStaticMarkup(
      <GlyphPicker color="magenta" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    expect(html).toContain('text-glyph-ring-magenta');
    expect(html).not.toContain('text-glyph-ring-blue');
  });

  test('the colour row offers all 8 and marks the selected one', () => {
    const html = renderToStaticMarkup(
      <GlyphPicker color="lime" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    const swatches = html.match(/data-swatch="/g) ?? [];
    expect(swatches).toHaveLength(8);
    expect(html).toMatch(/data-swatch="lime"[^>]*aria-pressed="true"/);
  });

  test('every glyph button is type="button"', () => {
    // The picker renders inside the create modal's <form>. A bare <button>
    // defaults to type="submit" and would submit the form on every pick.
    const html = renderToStaticMarkup(
      <GlyphPicker color="blue" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    const buttons = html.match(/<button[^>]*data-glyph=/g) ?? [];
    expect(buttons).toHaveLength(64);
    for (const b of buttons) expect(b).toContain('type="button"');
  });

  test('the grid geometry matches the emoji grid', () => {
    // Asserted against RENDERED markup, not source: the file's own doc
    // comment names these same three classes (deliberately — see the
    // stripComments note above), and rendered output contains no comments at
    // all, so only the real, shipped DOM can make this pass.
    const html = renderToStaticMarkup(
      <GlyphPicker color="blue" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    expect(html).toContain('size-8');
    expect(html).toContain('px-1.5');
    expect(html).toMatch(/grid-cols-9/);
  });

  test('is the same fixed height as the emoji picker', () => {
    // Comment-stripped source: EmojiPicker can't be rendered here the way
    // GlyphPicker is above (frimousse needs a self-hosted emoji dataset over
    // the network), so this still has to read source — but with every
    // comment removed first, so a doc comment naming `h-[368px]` (in either
    // file) can't feed the regex ahead of the real element.
    const glyph = stripComments(readFileSync(new URL('./glyph-picker.tsx', import.meta.url), 'utf8'));
    const emoji = stripComments(readFileSync(new URL('./emoji-picker.tsx', import.meta.url), 'utf8'));
    const height = /h-\[(\d+)px\]/;
    expect(glyph.match(height)?.[1]).toBe(emoji.match(height)?.[1]);
  });
});
