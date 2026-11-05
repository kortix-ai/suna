import { PROJECT_GLYPH_COLORS } from '@kortix/shared';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { glyphForeground, glyphStyle, glyphTint } from './glyph-tint';

describe('glyph tint', () => {
  test('a preset colour sets --glyph through its solid token and needs no inline style', () => {
    for (const color of PROJECT_GLYPH_COLORS) {
      expect(glyphTint(color)).toContain(`[--glyph:var(--glyph-solid-${color})]`);
      expect(glyphForeground(color)).toContain('text-[color:var(--glyph)]');
      expect(glyphStyle(color)).toBeUndefined();
    }
  });

  test('a custom #rrggbb colour comes in as an inline --glyph style', () => {
    expect(glyphStyle('#3fb6a8')).toEqual({ '--glyph': '#3fb6a8' } as never);
    expect(glyphTint('#3fb6a8')).not.toContain('--glyph-solid');
  });

  test('an unknown colour falls back to grey', () => {
    expect(glyphTint('chartreuse')).toBe(glyphTint('grey'));
    expect(glyphForeground('')).toBe(glyphForeground('grey'));
    expect(glyphStyle('#XYZ')).toBeUndefined();
  });

  test('every solid token is declared in theme.css', () => {
    const css = readFileSync(new URL('../styles/theme.css', import.meta.url), 'utf8');
    for (const color of PROJECT_GLYPH_COLORS) expect(css).toContain(`--glyph-solid-${color}: light-dark(`);
  });
});
