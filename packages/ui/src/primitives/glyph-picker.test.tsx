import { PROJECT_GLYPH_COLORS, PROJECT_GLYPH_NAMES } from '@kortix/shared';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GlyphPicker, matchesSearch } from './glyph-picker';
import { glyphFace } from './glyph-face';
import { UiProvider } from '../providers/ui-provider';
import { EntityAvatar } from './entity-avatar';

describe('matchesSearch', () => {
  test('an empty query matches everything', () => {
    expect(matchesSearch('Cat', '')).toBe(true);
    expect(matchesSearch('Rocket', '')).toBe(true);
  });

  test('a query matches the start of a keyword', () => {
    expect(matchesSearch('Cat', 'cat')).toBe(true);
    expect(matchesSearch('Rocket', 'deploy')).toBe(true);
    expect(matchesSearch('PiggyBank', 'sav')).toBe(true);
  });

  test('a query does NOT match the middle of a keyword', () => {
    // The regression this exists for. With `includes`, "cat" matched
    // `dupli(cat)e` on Copy and `notifi(cat)ion` on Bell, so searching for the
    // cat surfaced Copy and Bell alongside it. Tolerable across 64 glyphs,
    // actively misleading across 202.
    expect(matchesSearch('Copy', 'cat')).toBe(false);
    expect(matchesSearch('Bell', 'cat')).toBe(false);
  });

  test('an unknown glyph name matches nothing rather than throwing', () => {
    expect(matchesSearch('NotAGlyph', 'anything')).toBe(false);
  });

  test('a number circle is findable by both its word and its digit', () => {
    expect(matchesSearch('NumberCircleThree', 'three')).toBe(true);
    expect(matchesSearch('NumberCircleThree', '3')).toBe(true);
  });
});

const render = (color: string) =>
  renderToStaticMarkup(<GlyphPicker color={color} onColorChange={() => {}} onGlyphSelect={() => {}} />);

describe('GlyphPicker', () => {
  test('without branding, renders every catalogue glyph except the brand icon, Kortix marks first', () => {
    const html = render('grey');
    const glyphs = [...html.matchAll(/data-glyph="([^"]+)"/g)].map((m) => m[1]);
    expect(glyphs).toEqual(PROJECT_GLYPH_NAMES.filter((name) => name !== 'BrandIcon'));
    expect(glyphs.slice(0, 3)).toEqual(['KortixMark', 'KortixPixel', 'KortixDither']);
  });

  test('groups the grid under one heading per catalogue group', () => {
    expect(render('grey')).toContain('>Kortix</h3>');
  });

  test('offers the 8 presets plus a custom colour and marks the selected one', () => {
    const html = render('blue');
    for (const color of PROJECT_GLYPH_COLORS) expect(html).toContain(`data-swatch="${color}"`);
    expect(html).toContain('data-swatch="custom"');
    expect(html).toMatch(/data-swatch="blue" aria-pressed="true"/);
  });

  test('a custom #rrggbb colour opens the HEX field and sets --glyph inline', () => {
    const html = render('#3fb6a8');
    expect(html).toContain('--glyph:#3fb6a8');
    expect(html).toContain('aria-label="Hex colour"');
    expect(html).toContain('value="3FB6A8"');
  });

  test('an unknown colour resolves to grey', () => {
    const html = render('chartreuse');
    expect(html).toMatch(/data-swatch="grey" aria-pressed="true"/);
  });
});

describe('GlyphPicker — Enterprise brand icon', () => {
  const useBrand = () => ({ app_name: 'Acme', icon_url: 'data:image/svg+xml,acme' });
  const renderBranded = () =>
    renderToStaticMarkup(
      <UiProvider useBrand={useBrand}>
        <GlyphPicker color="grey" onColorChange={() => {}} onGlyphSelect={() => {}} />
      </UiProvider>,
    );

  test('shows the brand group, named after the brand, right after the Kortix marks', () => {
    const html = renderBranded();
    const glyphs = [...html.matchAll(/data-glyph="([^"]+)"/g)].map((m) => m[1]);
    expect(glyphs.slice(0, 4)).toEqual(['KortixMark', 'KortixPixel', 'KortixDither', 'BrandIcon']);
    expect(html).toContain('>Acme</h3>');
    expect(html).toContain('src="data:image/svg+xml,acme"');
  });

  test('a project tile wearing the brand icon shows the image full bleed, with no padding', () => {
    const html = renderToStaticMarkup(
      <UiProvider useBrand={useBrand}>
        <EntityAvatar label="Demo" glyph={{ name: 'BrandIcon', color: 'lime' }} size="lg" />
      </UiProvider>,
    );
    expect(html).toMatch(/data-slot="entity-avatar" class="[^"]*overflow-hidden/);
    // The border is a ring drawn over the image, not under it.
    expect(html).toMatch(/data-slot="entity-avatar" class="[^"]*after:inset-ring-1/);
    expect(html).toMatch(/data-brand-icon="" class="[^"]*size-full/);
    expect(html).toContain('object-cover');
    expect(html).not.toMatch(/data-brand-icon="" [^>]*style="width/);
  });

  test('the brand icon falls back to the Kortix mark when the account has no branding', () => {
    const plain = renderToStaticMarkup(createElement(glyphFace('BrandIcon')!, {}));
    expect(plain).toBe(renderToStaticMarkup(createElement(glyphFace('KortixMark')!, {})));
  });
});
