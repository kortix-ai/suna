import { describe, expect, test } from 'bun:test';

import { FileTextIcon } from '@phosphor-icons/react';

import { fileIconFor, getFileType } from '@/lib/utils/file-utils';

// Attachment tiles (user-message.tsx) and the file chips on a write row
// (activity-file-chips.tsx) both pick their glyph with `fileIconFor(filename)`.
//
// Two bugs live in this file's history. The original block hardcoded three
// branches — image / PDF / else — and the `else` fell through to an IMAGE glyph,
// so every spreadsheet, archive and log file in a transcript claimed to be a
// picture. The fix for that resolved by CATEGORY, which was honest but coarse:
// a `.ts`, a `.css` and a `.html` all drew the same anonymous code glyph, and a
// `.pdf`, a `.png` and a `.zip` were all just "a file".

describe('fileIconFor', () => {
  test('a non-image attachment never resolves to the image glyph', () => {
    const imageGlyph = fileIconFor('photo.gif');

    for (const name of ['data.csv', 'report.xlsx', 'bundle.zip', 'server.log', 'db.sqlite']) {
      expect(fileIconFor(name)).not.toBe(imageGlyph);
    }
  });

  test('each file type gets its OWN glyph, not a category glyph', () => {
    // The point of the change: these are all distinct marks.
    const names = [
      'index.html',
      'styles.css',
      'main.ts',
      'app.tsx',
      'bundle.js',
      'view.jsx',
      'notes.md',
      'report.pdf',
      'sheet.xlsx',
      'rows.csv',
      'deck.pptx',
      'letter.docx',
      'chart.png',
      'photo.jpg',
      'logo.svg',
      'lib.rs',
      'script.py',
      'query.sql',
      'archive.zip',
      'readme.txt',
    ];
    const glyphs = names.map(fileIconFor);
    // No two of these may share an icon.
    expect(new Set(glyphs).size).toBe(names.length);
  });

  test('extensions that mean the same thing share a glyph', () => {
    expect(fileIconFor('a.jpg')).toBe(fileIconFor('a.jpeg'));
    expect(fileIconFor('a.md')).toBe(fileIconFor('a.mdx'));
    expect(fileIconFor('a.css')).toBe(fileIconFor('a.scss'));
    expect(fileIconFor('a.ts')).toBe(fileIconFor('a.mts'));
    expect(fileIconFor('a.doc')).toBe(fileIconFor('a.docx'));
  });

  test('an unknown extension falls back to the text glyph, not an image', () => {
    // Note this is NOT the `.txt` glyph — Phosphor draws those differently, and
    // claiming a `.qqq` is a text file would be a guess.
    expect(fileIconFor('mystery.qqq')).toBe(FileTextIcon);
    expect(fileIconFor('mystery.qqq')).not.toBe(fileIconFor('chart.png'));
  });

  test('a name with no extension never borrows one', () => {
    // `'key'.split('.').pop()` is `'key'`, which is a real key in the table —
    // so an extension-less file called `key` would have drawn a Keynote deck.
    expect(fileIconFor('LICENSE')).toBe(FileTextIcon);
    expect(fileIconFor('Makefile')).toBe(FileTextIcon);
    expect(fileIconFor('key')).toBe(FileTextIcon);
    expect(fileIconFor('css')).toBe(FileTextIcon);
  });

  test('the lookup is case-insensitive', () => {
    expect(fileIconFor('REPORT.PDF')).toBe(fileIconFor('report.pdf'));
    expect(fileIconFor('Chart.PNG')).toBe(fileIconFor('chart.png'));
  });

  test('getFileType still classifies for the type LABEL under the name', () => {
    // The chip's second line is still category-based; only the glyph changed.
    expect(getFileType('chart.png')).toBe('image');
    expect(getFileType('report.pdf')).toBe('pdf');
    expect(getFileType('main.ts')).toBe('code');
    expect(getFileType('notes.md')).toBe('markdown');
  });
});
