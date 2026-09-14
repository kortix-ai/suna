import { describe, expect, test } from 'bun:test';
import {
  PROJECT_GLYPH_COLORS,
  PROJECT_GLYPH_GROUPS,
  PROJECT_GLYPH_NAMES,
  isProjectGlyphColor,
  isProjectGlyphName,
} from './project-glyphs';

describe('the glyph catalogue', () => {
  test('is 202 names in 17 groups: 16 of 12 and one of 10', () => {
    expect(PROJECT_GLYPH_NAMES).toHaveLength(202);
    expect(PROJECT_GLYPH_GROUPS).toHaveLength(17);
    // Groups are not uniform size: 16 categories carry 12 glyphs each, and the
    // Numbers group (drawn digit pictograms, not typographic characters) carries
    // 10 — one NumberCircle* glyph per digit 0-9. Asserting the exact shape
    // (rather than dropping the check because sizes differ) is what still fails
    // if a group silently gains or loses a glyph.
    const sizes = PROJECT_GLYPH_GROUPS.map((group) => group.names.length);
    const numbersIndex = PROJECT_GLYPH_GROUPS.findIndex((group) => group.label === 'Numbers');
    expect(numbersIndex).toBeGreaterThanOrEqual(0);
    sizes.forEach((size, index) => {
      expect(size).toBe(index === numbersIndex ? 10 : 12);
    });
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
  });

  test('names are PascalCase Phosphor identifiers', () => {
    // The registry maps these straight onto imported components, so a
    // lowercase or kebab name would be a lookup miss at render time.
    for (const name of PROJECT_GLYPH_NAMES) {
      expect(name).toMatch(/^[A-Z][A-Za-z]*$/);
    }
  });
});
