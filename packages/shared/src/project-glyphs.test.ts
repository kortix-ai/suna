import { describe, expect, test } from 'bun:test';
import {
  PROJECT_GLYPH_COLORS,
  PROJECT_GLYPH_GROUPS,
  PROJECT_GLYPH_NAMES,
  isProjectGlyphColor,
  isProjectGlyphName,
} from './project-glyphs';

describe('the glyph catalogue', () => {
  test('is 64 names in 8 groups of 8', () => {
    expect(PROJECT_GLYPH_NAMES).toHaveLength(64);
    expect(PROJECT_GLYPH_GROUPS).toHaveLength(8);
    for (const group of PROJECT_GLYPH_GROUPS) {
      expect(group.names).toHaveLength(8);
    }
  });

  test('every grouped name appears in the flat list, and vice versa', () => {
    // The flat list is what the validator allowlists; the groups are what the
    // grid renders. A name in one but not the other is either an unpickable
    // glyph or an unsavable one.
    const grouped = PROJECT_GLYPH_GROUPS.flatMap((g) => g.names).sort();
    expect(grouped).toEqual([...PROJECT_GLYPH_NAMES].sort());
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
