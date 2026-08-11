import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WORKSPACE_GLYPH_COLORS } from '@kortix/shared';
import { glyphForeground, glyphTint, glyphTintHover } from './glyph-tint';

describe('glyph tint', () => {
  test('every palette colour has a tint, a hover, and a foreground', () => {
    for (const color of WORKSPACE_GLYPH_COLORS) {
      expect(glyphTint(color)).toContain(`bg-glyph-fill-${color}`);
      expect(glyphTint(color)).toContain(`inset-ring-glyph-ring-${color}`);
      expect(glyphTintHover(color)).toContain(`hover:bg-glyph-fill-${color}`);
      expect(glyphForeground(color)).toContain(`text-glyph-ring-${color}`);
    }
  });

  test('an unknown colour falls back to grey rather than returning nothing', () => {
    // A missing class string leaves an untinted, unringed tile that reads as a
    // rendering bug. Grey is a real member of the palette, so the fallback is
    // indistinguishable from a deliberate choice.
    expect(glyphTint('chartreuse')).toBe(glyphTint('grey'));
    expect(glyphForeground('')).toBe(glyphForeground('grey'));
  });

  test('every class is a LITERAL in the source, never interpolated', () => {
    // Tailwind v4 extracts class names by scanning source TEXT. A template
    // literal or .map()-generated name emits no CSS at all and the tint
    // silently never paints. This has already happened once on this feature.
    const source = readFileSync(new URL('./glyph-tint.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*(bg-|text-|inset-ring-)/);
    for (const color of WORKSPACE_GLYPH_COLORS) {
      expect(source).toContain(`bg-glyph-fill-${color}`);
      expect(source).toContain(`text-glyph-ring-${color}`);
    }
  });

  test('every token used here is defined in globals.css', () => {
    // Catches a class naming a token nobody declared — which compiles to a
    // valid-looking class with no colour behind it.
    const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
    for (const color of WORKSPACE_GLYPH_COLORS) {
      expect(css).toContain(`--color-glyph-fill-${color}:`);
      expect(css).toContain(`--color-glyph-ring-${color}:`);
    }
  });
});
