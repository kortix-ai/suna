import { describe, expect, test } from 'bun:test';
import { bundledThemesInfo } from 'shiki';

import { SHIKI_THEME_DARK, SHIKI_THEME_LIGHT } from './code-theme';

describe('the code palette', () => {
  test('is min-dark / min-light', () => {
    expect(SHIKI_THEME_DARK).toBe('min-dark');
    expect(SHIKI_THEME_LIGHT).toBe('min-light');
  });

  test('names two different themes, so one cache key cannot serve both', () => {
    expect(SHIKI_THEME_DARK).not.toBe(SHIKI_THEME_LIGHT);
  });

  test('both halves are real bundled Shiki themes, not typos', () => {
    const ids = bundledThemesInfo.map((theme) => theme.id);

    expect(ids).toContain(SHIKI_THEME_DARK);
    expect(ids).toContain(SHIKI_THEME_LIGHT);
  });
});
