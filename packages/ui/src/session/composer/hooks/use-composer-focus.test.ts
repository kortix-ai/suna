import { describe, expect, test } from 'bun:test';

import { isPasteShortcut } from './use-composer-focus';

const key = (init: Partial<Parameters<typeof isPasteShortcut>[0]>) => ({
  key: 'v',
  code: 'KeyV',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...init,
});

describe('isPasteShortcut', () => {
  test('⌘V, Ctrl+V and their Shift forms are paste', () => {
    expect(isPasteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPasteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPasteShortcut(key({ metaKey: true, key: 'V' }))).toBe(true);
  });

  test('V without ⌘ or Ctrl, and other shortcuts, are not paste', () => {
    expect(isPasteShortcut(key({}))).toBe(false);
    expect(isPasteShortcut(key({ metaKey: true, key: 'c', code: 'KeyC' }))).toBe(false);
  });

  test('AltGr (Ctrl+Alt) is not paste: it types a character on some layouts', () => {
    expect(isPasteShortcut(key({ ctrlKey: true, altKey: true, key: '@' }))).toBe(false);
  });

  test('a Latin layout decides by the letter, not the physical key', () => {
    // Dvorak: the V key sits on `Period`; `KeyV` types `k`.
    expect(isPasteShortcut(key({ ctrlKey: true, key: 'v', code: 'Period' }))).toBe(true);
    expect(isPasteShortcut(key({ ctrlKey: true, key: 'k', code: 'KeyV' }))).toBe(false);
  });

  test('a non-Latin layout decides by the physical key', () => {
    expect(isPasteShortcut(key({ ctrlKey: true, key: 'м', code: 'KeyV' }))).toBe(true);
    expect(isPasteShortcut(key({ ctrlKey: true, key: 'с', code: 'KeyC' }))).toBe(false);
  });
});
