import { describe, expect, test } from 'bun:test';

import { getFileIcon, getFileType } from '@/lib/utils/file-utils';

// `MessageAttachments` (user-message.tsx) picks an attachment's glyph with
// `getFileIcon(getFileType(filename))`. The block it replaced hardcoded three
// branches — image / PDF / else — and the `else` fell through to an IMAGE
// glyph, so every spreadsheet, archive and log file in a transcript claimed to
// be a picture. These assert the mapping that fix relies on.

describe('attachment icon mapping', () => {
  test('a non-image, non-PDF attachment does NOT resolve to the image glyph', () => {
    const imageGlyph = getFileIcon('image');

    for (const name of ['data.csv', 'report.xlsx', 'bundle.zip', 'server.log', 'db.sqlite']) {
      expect(getFileIcon(getFileType(name))).not.toBe(imageGlyph);
    }
  });

  test('each kind resolves to its own glyph', () => {
    expect(getFileType('chart.png')).toBe('image');
    expect(getFileType('report.pdf')).toBe('pdf');
    expect(getFileType('rows.csv')).toBe('csv');
    expect(getFileType('sheet.xlsx')).toBe('spreadsheet');
    expect(getFileType('bundle.zip')).toBe('archive');
    expect(getFileType('main.ts')).toBe('code');
    expect(getFileType('notes.md')).toBe('markdown');
  });

  test('an unknown extension falls back to the generic file glyph, not an image', () => {
    expect(getFileType('mystery.qqq')).toBe('other');
    expect(getFileIcon(getFileType('mystery.qqq'))).not.toBe(getFileIcon('image'));
  });

  test('a name with no extension is still handled', () => {
    expect(getFileType('LICENSE')).toBe('other');
    expect(getFileIcon(getFileType('LICENSE'))).toBeDefined();
  });
});
