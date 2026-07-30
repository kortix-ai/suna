import { describe, expect, test } from 'bun:test';

import { normalizeProjectIcon } from './project-icon';

describe('normalizeProjectIcon', () => {
  test('accepts a plain emoji', () => {
    expect(normalizeProjectIcon('🚀')).toBe('🚀');
  });

  test('accepts a skin-toned emoji', () => {
    expect(normalizeProjectIcon('👍🏽')).toBe('👍🏽');
  });

  test('accepts a ZWJ sequence', () => {
    expect(normalizeProjectIcon('👩‍💻')).toBe('👩‍💻');
  });

  test('accepts a four-person family ZWJ sequence', () => {
    expect(normalizeProjectIcon('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
  });

  test('accepts a 35-byte ZWJ sequence (regression: a 32-byte cap rejected this)', () => {
    const emoji = '👩🏽‍❤️‍💋‍👨🏿';
    expect(new TextEncoder().encode(emoji).length).toBe(35);
    expect(normalizeProjectIcon(emoji)).toBe(emoji);
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeProjectIcon('  🚀  ')).toBe('🚀');
  });

  test('rejects plain text', () => {
    expect(normalizeProjectIcon('abc')).toBeNull();
  });

  test('rejects a single non-pictographic character', () => {
    expect(normalizeProjectIcon('A')).toBeNull();
  });

  test('rejects an empty string', () => {
    expect(normalizeProjectIcon('')).toBeNull();
  });

  test('rejects whitespace only', () => {
    expect(normalizeProjectIcon('   ')).toBeNull();
  });

  test('rejects two emoji', () => {
    expect(normalizeProjectIcon('🚀🚀')).toBeNull();
  });

  test('rejects an emoji followed by text', () => {
    expect(normalizeProjectIcon('🚀 launch')).toBeNull();
  });

  test('rejects an oversized string', () => {
    expect(normalizeProjectIcon('x'.repeat(5000))).toBeNull();
  });

  test('rejects a repeated-emoji string over the byte cap', () => {
    expect(normalizeProjectIcon('🚀'.repeat(100))).toBeNull();
  });

  test('rejects non-string input', () => {
    expect(normalizeProjectIcon(null)).toBeNull();
    expect(normalizeProjectIcon(undefined)).toBeNull();
    expect(normalizeProjectIcon(42)).toBeNull();
    expect(normalizeProjectIcon({ icon: '🚀' })).toBeNull();
  });
});
