import { describe, expect, test } from 'bun:test';

import { type ClipboardItemLike, extractClipboardFiles } from './clipboard-files';

function png(name = 'image.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
}

function fileItem(file: File | null): ClipboardItemLike {
  return { kind: 'file', getAsFile: () => file };
}

function stringItem(): ClipboardItemLike {
  return { kind: 'string', getAsFile: () => null };
}

describe('extractClipboardFiles', () => {
  test('returns files from the files list (copied image / screenshot paste)', () => {
    const file = png();
    const result = extractClipboardFiles({ files: [file], items: [] });
    expect(result).toEqual([file]);
  });

  test('falls back to file items when the files list is empty', () => {
    const file = png('screenshot.png');
    const result = extractClipboardFiles({ files: [], items: [fileItem(file)] });
    expect(result).toEqual([file]);
  });

  test('prefers the files list and does not double-count items', () => {
    const file = png();
    const result = extractClipboardFiles({ files: [file], items: [fileItem(file)] });
    expect(result).toEqual([file]);
  });

  test('ignores non-file items and null getAsFile results', () => {
    const result = extractClipboardFiles({
      files: [],
      items: [stringItem(), fileItem(null)],
    });
    expect(result).toEqual([]);
  });

  test('returns an empty array for a plain-text paste (no files, no file items)', () => {
    expect(extractClipboardFiles({ files: [], items: [stringItem()] })).toEqual([]);
  });

  test('returns an empty array when the clipboard payload is missing', () => {
    expect(extractClipboardFiles(null)).toEqual([]);
    expect(extractClipboardFiles(undefined)).toEqual([]);
  });

  test('keeps every pasted file when multiple are present', () => {
    const a = png('a.png');
    const b = png('b.png');
    expect(extractClipboardFiles({ files: [a, b], items: [] })).toEqual([a, b]);
  });
});
