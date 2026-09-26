import { describe, expect, test } from 'bun:test';

import { mimeTypeForFile } from './mime-type';

describe('mimeTypeForFile', () => {
  test('names the type the device uses to pick an app', () => {
    expect(mimeTypeForFile('report.pdf')).toBe('application/pdf');
    expect(mimeTypeForFile('data.CSV')).toBe('text/csv');
    expect(mimeTypeForFile('notes.md')).toBe('text/markdown');
    expect(mimeTypeForFile('index.html')).toBe('text/html');
    expect(mimeTypeForFile('a.json')).toBe('application/json');
    expect(mimeTypeForFile('a.txt')).toBe('text/plain');
    expect(mimeTypeForFile('a.png')).toBe('image/png');
    expect(mimeTypeForFile('a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    expect(mimeTypeForFile('a.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(mimeTypeForFile('a.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
  });

  test('source files open as plain text', () => {
    for (const name of ['main.ts', 'app.py', 'style.css', 'config.yaml']) {
      expect(mimeTypeForFile(name)).toBe('text/plain');
    }
  });

  test('is undefined for an unknown or missing extension', () => {
    expect(mimeTypeForFile('archive.xyz')).toBeUndefined();
    expect(mimeTypeForFile('Makefile')).toBeUndefined();
  });
});
