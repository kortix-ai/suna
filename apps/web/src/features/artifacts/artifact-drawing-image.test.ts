import { expect, test } from 'bun:test';
import { compositeDrawingImage, drawingImageBase64 } from './artifact-drawing-image';

test('the screenshot burns each stored color as its brand hex value', async () => {
  const paints: string[] = [];
  const context = new Proxy(
    {},
    {
      get: (_target, key) => (key === 'canvas' ? undefined : () => undefined),
      set: (_target, key, value) => {
        if (key === 'strokeStyle' || key === 'fillStyle') paints.push(`${String(key)}:${value}`);
        return true;
      },
    },
  );
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (done: (blob: Blob) => void) => done(new Blob([new Uint8Array(4)])),
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { document: globals.document, createImageBitmap: globals.createImageBitmap };
  globals.document = { createElement: () => canvas };
  globals.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
  try {
    const line = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ];
    const dot = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ];
    await compositeDrawingImage(
      new Blob([]),
      [
        { tool: 'pen', color: 'red', width: 0.01, points: line },
        { tool: 'arrow', color: 'blue', width: 0.01, points: line },
        { tool: 'pen', color: 'black', width: 0.01, points: dot },
      ],
      10,
      10,
    );
  } finally {
    globals.document = previous.document;
    globals.createImageBitmap = previous.createImageBitmap;
  }
  // A canvas cannot read CSS variables: the burned stroke takes kortix-red, kortix-blue, ink.
  expect(paints).toEqual([
    'strokeStyle:#f14b4c',
    'strokeStyle:#2b91f7',
    'strokeStyle:#1f1f1f',
    'fillStyle:#1f1f1f',
  ]);
});

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
