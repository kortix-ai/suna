import { describe, expect, test } from 'bun:test';

import { assertUploadedFileParts, promptParts } from './prompt-parts';
import type { AttachedFile } from './attachments';

const readyPart = {
  type: 'file' as const,
  attachment_id: '11111111-1111-1111-1111-111111111111',
  mime: 'image/jpeg',
  filename: 'photo_1.jpg',
};

describe('promptParts', () => {
  test('text plus one image gives a text part then a file part', () => {
    expect(promptParts('hi', [readyPart])).toEqual([{ type: 'text', text: 'hi' }, readyPart]);
  });

  test('image only omits the text part', () => {
    const parts = promptParts('', [readyPart]);
    expect(parts.length).toBe(1);
    expect(parts[0]!.type).toBe('file');
  });

  test('empty text and no files throws', () => {
    expect(() => promptParts('   ', [])).toThrow('A prompt needs text or a file');
  });
});

describe('assertUploadedFileParts', () => {
  const file: AttachedFile = {
    uri: 'file:///cache/photo_1.jpg',
    name: 'photo_1.jpg',
    mimeType: 'image/jpeg',
    isImage: true,
    uploadId: 'attachment-1',
  };

  test('throws when a file has no uploadId', () => {
    const { uploadId: _uploadId, ...withoutUploadId } = file;
    expect(() => assertUploadedFileParts([withoutUploadId], [readyPart])).toThrow(
      'A staged attachment is missing its completed upload handle',
    );
  });

  test('throws when the ready part has no attachment_id', () => {
    const badPart = { type: 'file' as const, mime: 'image/jpeg', filename: 'photo_1.jpg' } as any;
    expect(() => assertUploadedFileParts([file], [badPart])).toThrow(
      'A staged attachment is missing its completed upload handle',
    );
  });

  test('returns the ready parts when every file has an uploadId', () => {
    expect(assertUploadedFileParts([file], [readyPart])).toEqual([readyPart]);
  });
});
