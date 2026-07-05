import { describe, expect, test } from 'bun:test';

import { getShowFileCategory, resolveShowType } from './show-type-utils';

describe('resolveShowType', () => {
  test('a markdown-declared .csv renders as csv (extension wins)', () => {
    expect(resolveShowType('markdown', '/w/data.csv')).toBe('csv');
  });

  test('a text-declared .xlsx renders as xlsx (extension wins)', () => {
    expect(resolveShowType('text', '/w/report.xlsx')).toBe('xlsx');
  });

  test('a markdown-declared .md stays markdown (not a rich category)', () => {
    expect(resolveShowType('markdown', '/w/notes.md')).toBe('markdown');
  });

  test('type=file auto-detects a .docx path', () => {
    expect(resolveShowType('file', '/w/doc.docx')).toBe('docx');
  });

  test('an explicit image declaration is never overridden', () => {
    expect(resolveShowType('image', '/w/photo.png')).toBe('image');
  });

  test('a markdown declaration with no path stays markdown', () => {
    expect(resolveShowType('markdown', '')).toBe('markdown');
  });

  test('code with a non-rich .py extension stays code', () => {
    expect(resolveShowType('code', '/w/script.py')).toBe('code');
  });

  test('a textish declaration with a non-rich extension keeps the declared type', () => {
    expect(getShowFileCategory('/w/script.py')).toBe('file');
    expect(resolveShowType('text', '/w/script.py')).toBe('text');
  });
});
