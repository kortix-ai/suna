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

  test('renders one continuous grid, not one sub-grid per category', () => {
    // This picker used to render 8 sticky category headers (`Objects`,
    // `Shapes`, ... `Symbols`) with a `grid-cols-9` sub-grid under each.
    // Review feedback dropped the grouping; this pins both halves of that:
    // none of the category labels render as a heading, and there is exactly
    // one `grid-cols-9` grid, not eight. `PROJECT_GLYPH_GROUPS` still exists
    // (it is the ordering source `PROJECT_GLYPH_NAMES` flattens from) so this
    // reads its labels directly off the shared catalogue rather than
    // hardcoding them, and would fail if grouping ever came back.
    const html = renderToStaticMarkup(
      <GlyphPicker color="blue" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    // Word-boundary match, not plain `toContain`: the Arrows group's own
    // `ArrowsClockwise` glyph name contains "Arrows" as a substring, so a bare
    // `toContain('Arrows')` would fail even with headers correctly removed.
    for (const group of PROJECT_GLYPH_GROUPS) {
      expect(html).not.toMatch(new RegExp(`\\b${group.label}\\b`));
    }
    const grids = html.match(/grid-cols-9/g) ?? [];
    expect(grids).toHaveLength(1);
  });

  test('the colour row sits before the glyph grid in DOM order', () => {
    // The colour row moved from a footer below the grid to a header row
    // directly under search. Asserted on markup order, not just presence, so
    // a regression that keeps the row but puts it back at the bottom fails.
    const html = renderToStaticMarkup(
      <GlyphPicker color="blue" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    const swatchIndex = html.indexOf('data-swatch="');
    const glyphIndex = html.indexOf('data-glyph="');
    expect(swatchIndex).toBeGreaterThan(-1);
    expect(glyphIndex).toBeGreaterThan(-1);
    expect(swatchIndex).toBeLessThan(glyphIndex);
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

describe('GlyphPicker click commits the resolved colour, not the raw prop', () => {
  test('an out-of-palette color resolves to grey everywhere in the grid', () => {
    // `resolvedColor` (`resolveGlyphColor(color)`) is what every render path in
    // this file uses. This pins what it evaluates to for a stale/out-of-palette
    // value BEFORE the next test pins that the click handler commits that same
    // value rather than the raw `color` prop.
    const html = renderToStaticMarkup(
      <GlyphPicker color="chartreuse" onColorChange={() => {}} onGlyphSelect={() => {}} />,
    );
    expect(html).toMatch(/data-swatch="grey"[^>]*aria-pressed="true"/);
    expect(html).toContain('text-glyph-ring-grey');
    expect(html).not.toContain('chartreuse');
  });

  test('the glyph click handler commits the RESOLVED colour, not the raw prop', () => {
    // Every render path paints with `resolveGlyphColor(color)` — proven above: a
    // stale `chartreuse` prop paints grey. The click handler has to agree:
    // committing the raw `color` prop instead sends `{ name, color: "chartreuse" }`
    // to the server, `normalizeProjectGlyph` rejects it, the PATCH returns 200 and
    // writes nothing, and the picker still closes as if it had succeeded.
    //
    // apps/web has no DOM harness (no jsdom, no testing-library — see the note at
    // the top of project-icon-field.test.tsx's "remove control" describe block),
    // so a real click can't be simulated here. This reads the handler off source
    // the same way that file's `emojiHandler` / `glyphHandler` slices do.
    const code = stripComments(readFileSync(new URL('./glyph-picker.tsx', import.meta.url), 'utf8'));
    expect(code).toMatch(/onClick=\{\(\) => onGlyphSelect\(\{ name, color: resolvedColor \}\)\}/);
    expect(code).not.toMatch(/onGlyphSelect\(\{ name, color \}\)/);
  });
});
