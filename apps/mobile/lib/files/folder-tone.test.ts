import { describe, expect, test } from 'bun:test';

import { FOLDER_TONES, folderTone } from './folder-tone';

describe('folderTone', () => {
  test('the same name always gets the same tone', () => {
    expect(folderTone('src')).toBe(folderTone('src'));
    expect(folderTone('.kortix')).toBe(folderTone('.kortix'));
  });

  test('a tone is one of the brand accents', () => {
    for (const name of ['src', 'docs', 'assets', 'scripts', '.opencode', 'a', 'zz']) {
      expect(FOLDER_TONES).toContain(folderTone(name));
    }
  });

  test('different names spread across the palette', () => {
    const tones = new Set(['src', 'docs', 'assets', 'scripts', 'lib', 'app', 'components', 'tests'].map(folderTone));
    expect(tones.size).toBeGreaterThan(2);
  });

  test('case and a leading dot do not change the tone', () => {
    expect(folderTone('Docs')).toBe(folderTone('docs'));
    expect(folderTone('.docs')).toBe(folderTone('docs'));
  });
});
