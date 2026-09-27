import { describe, expect, test } from 'bun:test';

import { ATTACH_SOURCES, documentAssetToFile, imageAssetToFile } from './attach-sources';

describe('ATTACH_SOURCES', () => {
  test('lists Camera, Photos, Files in that order', () => {
    expect(ATTACH_SOURCES.map((s) => s.id)).toEqual(['camera', 'photos', 'files']);
    expect(ATTACH_SOURCES.map((s) => s.label)).toEqual(['Camera', 'Photos', 'Files']);
  });

  test('every source has a spoken hint', () => {
    for (const source of ATTACH_SOURCES) expect(source.hint.length).toBeGreaterThan(0);
  });
});

describe('imageAssetToFile', () => {
  test('keeps the picker values', () => {
    expect(
      imageAssetToFile({
        uri: 'file:///tmp/IMG_1.heic',
        fileName: 'IMG_1.heic',
        mimeType: 'image/heic',
        fileSize: 1200,
      }),
    ).toEqual({
      uri: 'file:///tmp/IMG_1.heic',
      name: 'IMG_1.heic',
      mimeType: 'image/heic',
      size: 1200,
      isImage: true,
    });
  });

  test('names a file after its URI when the picker gives no name', () => {
    const file = imageAssetToFile({ uri: 'file:///tmp/cache/abc.jpg', fileName: null });
    expect(file.name).toBe('abc.jpg');
    expect(file.mimeType).toBe('image/jpeg');
  });

  test('uses the fallback name when the URI has no file segment', () => {
    expect(imageAssetToFile({ uri: 'ph://', fileName: null }, 'photo_1.jpg').name).toBe(
      'photo_1.jpg',
    );
  });
});

describe('documentAssetToFile', () => {
  test('marks an image document as an image', () => {
    expect(
      documentAssetToFile({ uri: 'file:///a.png', name: 'a.png', mimeType: 'image/png', size: 9 }),
    ).toEqual({ uri: 'file:///a.png', name: 'a.png', mimeType: 'image/png', size: 9, isImage: true });
  });

  test('falls back to octet-stream and is not an image', () => {
    const file = documentAssetToFile({ uri: 'file:///notes', name: 'notes' });
    expect(file.mimeType).toBe('application/octet-stream');
    expect(file.isImage).toBe(false);
  });
});
