import { describe, expect, test } from 'bun:test';
import {
  PROJECT_GLYPH_COLORS,
  PROJECT_GLYPH_GROUPS,
  PROJECT_GLYPH_NAMES,
  isProjectGlyphColor,
  normalizeProjectGlyphColor,
  isProjectGlyphName,
} from './project-glyphs';

describe('the glyph catalogue', () => {
  test('is 949 unique names in 39 non-empty groups, the Kortix marks first', () => {
    expect(PROJECT_GLYPH_NAMES).toHaveLength(949);
    expect(PROJECT_GLYPH_GROUPS).toHaveLength(39);
    expect(new Set(PROJECT_GLYPH_NAMES).size).toBe(PROJECT_GLYPH_NAMES.length);
    for (const group of PROJECT_GLYPH_GROUPS) expect(group.names.length).toBeGreaterThan(0);
    expect(PROJECT_GLYPH_GROUPS[0]?.names).toEqual(['KortixMark', 'KortixPixel', 'KortixDither']);
  });


  test('every grouped name appears in the flat list, and vice versa', () => {
    // The flat list is what the validator allowlists; the groups are what the
    // grid renders. A name in one but not the other is either an unpickable
    // glyph or an unsavable one.
    const grouped = PROJECT_GLYPH_GROUPS.flatMap((g) => g.names).sort();
    expect([...PROJECT_GLYPH_NAMES].sort()).toEqual(grouped);
  });

  test('no name is duplicated', () => {
    expect(new Set(PROJECT_GLYPH_NAMES).size).toBe(PROJECT_GLYPH_NAMES.length);
  });

  test('is 8 colours, with grey among them', () => {
    expect(PROJECT_GLYPH_COLORS).toHaveLength(8);
    expect(new Set(PROJECT_GLYPH_COLORS).size).toBe(8);
    // grey is deliberate: it makes "no colour" a real choice rather than an
    // absence, so a glyph project never has to look decorated.
    expect(PROJECT_GLYPH_COLORS).toContain('grey');
  });

  test('the guards accept members and reject everything else', () => {
    expect(isProjectGlyphName('Rocket')).toBe(true);
    expect(isProjectGlyphName('NotAGlyph')).toBe(false);
    expect(isProjectGlyphName('')).toBe(false);
    expect(isProjectGlyphColor('blue')).toBe(true);
    expect(isProjectGlyphColor('chartreuse')).toBe(false);
    expect(isProjectGlyphColor('')).toBe(false);
    // A custom colour is exact lower-case #rrggbb only.
    expect(isProjectGlyphColor('#3fb6a8')).toBe(true);
    expect(isProjectGlyphColor('#3FB6A8')).toBe(false);
    expect(isProjectGlyphColor('#3fb6a')).toBe(false);
    expect(isProjectGlyphColor('#3fb6a8ff')).toBe(false);
    expect(isProjectGlyphColor('red; background:url(x)')).toBe(false);
    expect(normalizeProjectGlyphColor('#3FB6A8')).toBe('#3fb6a8');
    expect(normalizeProjectGlyphColor('blue')).toBe('blue');
    expect(normalizeProjectGlyphColor('#zzzzzz')).toBeNull();
    expect(normalizeProjectGlyphColor(42)).toBeNull();
  });

  test('names are PascalCase Phosphor identifiers', () => {
    // The registry maps these straight onto imported components, so a
    // lowercase or kebab name would be a lookup miss at render time.
    for (const name of PROJECT_GLYPH_NAMES) {
      expect(name).toMatch(/^[A-Z][A-Za-z]*$/);
    }
  });
});
