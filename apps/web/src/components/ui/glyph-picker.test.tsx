import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROJECT_GLYPH_GROUPS } from '@kortix/shared';
import { GlyphPicker } from './glyph-picker';

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
    // Read from source, so a drift in either file fails rather than silently
    // changing the popover width on tab switch.
    const source = readFileSync(new URL('./glyph-picker.tsx', import.meta.url), 'utf8');
    expect(source).toContain('size-8');
    expect(source).toContain('px-1.5');
    expect(source).toMatch(/grid-cols-9/);
  });

  test('is the same fixed height as the emoji picker', () => {
    const glyph = readFileSync(new URL('./glyph-picker.tsx', import.meta.url), 'utf8');
    const emoji = readFileSync(new URL('./emoji-picker.tsx', import.meta.url), 'utf8');
    const height = /h-\[(\d+)px\]/;
    expect(glyph.match(height)?.[1]).toBe(emoji.match(height)?.[1]);
  });
});
