import { describe, expect, test } from 'bun:test';

import { normalizeWorkspaceIcon } from './workspace-icon';

describe('normalizeWorkspaceIcon', () => {
  test('accepts a plain emoji', () => {
    expect(normalizeWorkspaceIcon('🚀')).toBe('🚀');
  });

  test('accepts a skin-toned emoji', () => {
    expect(normalizeWorkspaceIcon('👍🏽')).toBe('👍🏽');
  });

  test('accepts a ZWJ sequence', () => {
    expect(normalizeWorkspaceIcon('👩‍💻')).toBe('👩‍💻');
  });

  test('accepts a four-person family ZWJ sequence', () => {
    expect(normalizeWorkspaceIcon('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
  });

  test('accepts a 35-byte ZWJ sequence (regression: a 32-byte cap rejected this)', () => {
    const emoji = '👩🏽‍❤️‍💋‍👨🏿';
    expect(new TextEncoder().encode(emoji).length).toBe(35);
    expect(normalizeWorkspaceIcon(emoji)).toBe(emoji);
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeWorkspaceIcon('  🚀  ')).toBe('🚀');
  });

  test('rejects plain text', () => {
    expect(normalizeWorkspaceIcon('abc')).toBeNull();
  });

  test('rejects a single non-pictographic character', () => {
    expect(normalizeWorkspaceIcon('A')).toBeNull();
  });

  test('rejects an empty string', () => {
    expect(normalizeWorkspaceIcon('')).toBeNull();
  });

  test('rejects whitespace only', () => {
    expect(normalizeWorkspaceIcon('   ')).toBeNull();
  });

  test('rejects two emoji', () => {
    expect(normalizeWorkspaceIcon('🚀🚀')).toBeNull();
  });

  test('rejects an emoji followed by text', () => {
    expect(normalizeWorkspaceIcon('🚀 launch')).toBeNull();
  });

  test('rejects an oversized string', () => {
    expect(normalizeWorkspaceIcon('x'.repeat(5000))).toBeNull();
  });

  test('rejects a repeated-emoji string over the byte cap', () => {
    expect(normalizeWorkspaceIcon('🚀'.repeat(100))).toBeNull();
  });

  test('rejects non-string input', () => {
    expect(normalizeWorkspaceIcon(null)).toBeNull();
    expect(normalizeWorkspaceIcon(undefined)).toBeNull();
    expect(normalizeWorkspaceIcon(42)).toBeNull();
    expect(normalizeWorkspaceIcon({ icon: '🚀' })).toBeNull();
  });

  test('accepts a country flag 🇺🇸', () => {
    expect(normalizeWorkspaceIcon('🇺🇸')).toBe('🇺🇸');
  });

  test('accepts another country flag 🇬🇧', () => {
    expect(normalizeWorkspaceIcon('🇬🇧')).toBe('🇬🇧');
  });

  test('accepts a keycap 1️⃣', () => {
    expect(normalizeWorkspaceIcon('1️⃣')).toBe('1️⃣');
  });

  test('accepts another keycap #️⃣', () => {
    expect(normalizeWorkspaceIcon('#️⃣')).toBe('#️⃣');
  });

  test('rejects a lone regional indicator', () => {
    expect(normalizeWorkspaceIcon('\u{1F1FA}')).toBeNull();
  });

  test('rejects two flags', () => {
    expect(normalizeWorkspaceIcon('🇺🇸🇬🇧')).toBeNull();
  });

  test('rejects a bare combining mark (no base)', () => {
    expect(normalizeWorkspaceIcon('⃣')).toBeNull();
  });

  test('rejects a keycap combining mark after non-digit (A⃣)', () => {
    expect(normalizeWorkspaceIcon('A⃣')).toBeNull();
  });

  test('rejects a keycap combining mark after non-digit (z⃣)', () => {
    expect(normalizeWorkspaceIcon('z⃣')).toBeNull();
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
    expect(normalizeWorkspaceIcon(exactly64)).toBe(exactly64);
  });

  test('rejects a single grapheme over MAX_ICON_BYTES', () => {
    const tags = Array.from({ length: 15 }, (_, i) => String.fromCodePoint(0xe0061 + i)).join('');
    const over = `\u{1F3F4}${tags}\u{E007F}`;
    expect(new TextEncoder().encode(over).length).toBe(68);
    expect(normalizeWorkspaceIcon(over)).toBeNull();
  });
});
