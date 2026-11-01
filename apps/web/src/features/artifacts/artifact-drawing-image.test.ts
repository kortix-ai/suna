import { expect, test } from 'bun:test';
import { drawingImageBase64 } from './artifact-drawing-image';

test('encoding the full upload limit preserves bytes without a large argument-list call', async () => {
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, index) => index % 256);
  const encoded = await drawingImageBase64(new Blob([bytes], { type: 'image/png' }));
  const decoded = atob(encoded);
  expect(decoded.length).toBe(bytes.length);
  for (const index of [0, 255, 256, bytes.length - 1])
    expect(decoded.charCodeAt(index)).toBe(bytes[index]);
});

test('oversized images fail before reading or encoding their contents', async () => {
  const blob = new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]);
  await expect(drawingImageBase64(blob)).rejects.toThrow('Image exceeds upload limit');
});
