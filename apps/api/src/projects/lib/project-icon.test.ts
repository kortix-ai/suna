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

  test('rejects a bare combining mark (no base)', () => {
    expect(normalizeProjectIcon('⃣')).toBeNull();
  });

  test('rejects a keycap combining mark after non-digit (A⃣)', () => {
    expect(normalizeProjectIcon('A⃣')).toBeNull();
  });

  test('rejects a keycap combining mark after non-digit (z⃣)', () => {
    expect(normalizeProjectIcon('z⃣')).toBeNull();
  });

  test('accepts a single grapheme of exactly MAX_ICON_BYTES (64) bytes', () => {
    const tags = Array.from({ length: 14 }, (_, i) => String.fromCodePoint(0xe0061 + i)).join('');
    const exactly64 = `\u{1F3F4}${tags}\u{E007F}`;
    // Pin the length exactly — a tolerant assertion here is what let an
    // off-by-one at the cap slip through the previous round.
    expect(new TextEncoder().encode(exactly64).length).toBe(64);
    expect([
      ...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(exactly64),
    ]).toHaveLength(1);
    expect(normalizeProjectIcon(exactly64)).toBe(exactly64);
  });

  test('rejects a single grapheme over MAX_ICON_BYTES', () => {
    const tags = Array.from({ length: 15 }, (_, i) => String.fromCodePoint(0xe0061 + i)).join('');
    const over = `\u{1F3F4}${tags}\u{E007F}`;
    expect(new TextEncoder().encode(over).length).toBe(68);
    expect(normalizeProjectIcon(over)).toBeNull();
  });
});
