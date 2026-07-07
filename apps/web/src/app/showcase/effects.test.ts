import { describe, expect, test } from 'bun:test';
import { getEffect, SHOWCASE_EFFECTS } from './effects';

describe('SHOWCASE_EFFECTS registry', () => {
  test('has at least one effect', () => {
    expect(SHOWCASE_EFFECTS.length).toBeGreaterThan(0);
  });

  test('every slug is unique', () => {
    const slugs = SHOWCASE_EFFECTS.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('slugs are URL-safe kebab-case', () => {
    for (const effect of SHOWCASE_EFFECTS) {
      expect(effect.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  test('every effect declares a supported layout', () => {
    for (const effect of SHOWCASE_EFFECTS) {
      expect(['framed', 'fullscreen']).toContain(effect.layout);
    }
  });
});

describe('getEffect', () => {
  test('returns the matching effect by slug', () => {
    const effect = getEffect('particle-assembly');
    expect(effect?.name).toBe('Particle Assembly');
  });

  test('returns undefined for an unknown slug', () => {
    expect(getEffect('does-not-exist')).toBeUndefined();
  });

  test('resolves every registered slug', () => {
    for (const effect of SHOWCASE_EFFECTS) {
      expect(getEffect(effect.slug)).toBe(effect);
    }
  });
});
