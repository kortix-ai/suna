import { describe, expect, test } from 'bun:test';

import { resolveDocxSource } from './docx-renderer';

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
