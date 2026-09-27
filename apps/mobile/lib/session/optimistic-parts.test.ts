import { describe, expect, test } from 'bun:test';

import type { AttachedFile } from './attachments';
import { optimisticUserParts } from './optimistic-parts';

const NOW = 1755500000000;
const PHOTO: AttachedFile = {
  uri: 'file:///cache/photo_1.jpg',
  name: 'photo_1.jpg',
  mimeType: 'image/jpeg',
  isImage: true,
};

describe('optimisticUserParts', () => {
  test('text only gives one prt_ text part with the text as given', () => {
    const parts = optimisticUserParts('hello ', [], NOW);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'text', text: 'hello ' });
    expect(parts[0].id.startsWith(`prt_${NOW}_`)).toBe(true);
  });

  test('blank text gives no text part', () => {
    expect(optimisticUserParts('   ', [], NOW)).toEqual([]);
  });

  test('image only gives one file part carrying the local uri', () => {
    const parts = optimisticUserParts('', [PHOTO], NOW);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: 'file',
      mime: 'image/jpeg',
      filename: 'photo_1.jpg',
      url: undefined,
      localUri: 'file:///cache/photo_1.jpg',
    });
  });

  test('text and files: text first, then one file part per file, all ids unique', () => {
    const second: AttachedFile = { ...PHOTO, uri: 'file:///cache/photo_2.jpg', name: 'photo_2.jpg' };
    const parts = optimisticUserParts('look', [PHOTO, second], NOW);
    expect(parts.map((p) => p.type)).toEqual(['text', 'file', 'file']);
    expect(new Set(parts.map((p) => p.id)).size).toBe(3);
    expect(parts.every((p) => p.id.startsWith('prt_'))).toBe(true);
  });
});
