import { describe, expect, test } from 'bun:test';

import { ensureDocxFileName, resolveDocxSource } from './docx-renderer';

describe('ensureDocxFileName', () => {
  test('returns a default name when the file name is missing', () => {
    expect(ensureDocxFileName(undefined)).toBe('document.docx');
  });

  test('passes through a name that already ends in .docx', () => {
    expect(ensureDocxFileName('Report.docx')).toBe('Report.docx');
  });

  test('passes through a legacy .doc name (case-insensitive)', () => {
    expect(ensureDocxFileName('Report.DOC')).toBe('Report.DOC');
  });

  test('appends .docx to a bare name', () => {
    expect(ensureDocxFileName('notes')).toBe('notes.docx');
  });

  test('returns a default name for a blank/whitespace name', () => {
    expect(ensureDocxFileName('  ')).toBe('document.docx');
  });
});

describe('resolveDocxSource', () => {
  test('prefers blob over url and returns a revocable object URL', () => {
    const blob = new Blob(['fake'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const created: Blob[] = [];
    const result = resolveDocxSource({
      url: 'https://example.com/doc.docx',
      blob,
      createObjectUrl: (b) => {
        created.push(b);
        return 'blob:mock-1';
      },
    });
    expect(result).toEqual({ src: 'blob:mock-1', revocable: true });
    expect(created).toEqual([blob]);
  });

  test('falls back to url without creating an object URL', () => {
    const result = resolveDocxSource({
      url: 'https://example.com/doc.docx',
      createObjectUrl: () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toEqual({ src: 'https://example.com/doc.docx', revocable: false });
  });

  test('returns null src when no source is provided', () => {
    const result = resolveDocxSource({ createObjectUrl: () => 'blob:never' });
    expect(result).toEqual({ src: null, revocable: false });
  });
});
