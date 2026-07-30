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

  test('accepts a country flag 🇺🇸', () => {
    expect(normalizeProjectIcon('🇺🇸')).toBe('🇺🇸');
  });

  test('accepts another country flag 🇬🇧', () => {
    expect(normalizeProjectIcon('🇬🇧')).toBe('🇬🇧');
  });

  test('accepts a keycap 1️⃣', () => {
    expect(normalizeProjectIcon('1️⃣')).toBe('1️⃣');
  });

  test('accepts another keycap #️⃣', () => {
    expect(normalizeProjectIcon('#️⃣')).toBe('#️⃣');
  });

  test('rejects a lone regional indicator', () => {
    expect(normalizeProjectIcon('\u{1F1FA}')).toBeNull();
  });

  test('rejects two flags', () => {
    expect(normalizeProjectIcon('🇺🇸🇬🇧')).toBeNull();
  });

  test('accepts a single grapheme at exactly the 64-byte cap', () => {
    // Construct an emoji sequence that measures exactly or just under 64 bytes
    // 👨‍👩‍👧‍👦 is 25 bytes (4 people + 3 ZWJ), with modifiers we can reach near 64
    const emoji = '👨🏿‍👩🏿‍👧🏿‍👦🏿';
    const bytes = new TextEncoder().encode(emoji).length;
    expect(bytes).toBeLessThanOrEqual(64);
    expect(normalizeProjectIcon(emoji)).toBe(emoji);
  });

  test('rejects a single grapheme over the 64-byte cap', () => {
    // Create a string just over 64 bytes
    const overCap = '🚀'.repeat(20);
    const bytes = new TextEncoder().encode(overCap).length;
    expect(bytes).toBeGreaterThan(64);
    expect(normalizeProjectIcon(overCap)).toBeNull();
  });
});
