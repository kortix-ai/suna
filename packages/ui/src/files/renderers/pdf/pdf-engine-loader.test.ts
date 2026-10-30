import { afterAll, expect, mock, test } from 'bun:test';

const failure = new Error('synthetic pdfium initialization failure');
const createPdfiumEngine = mock((_url: string, _options: object) => Promise.reject(failure));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

mock.module('@embedpdf/engines/pdfium-worker-engine', () => ({ createPdfiumEngine }));
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: { origin: 'https://pdf.example.test' } },
});

afterAll(() => {
  mock.restore();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('PDF viewers share initialization, use an absolute worker URL, and retain initialization failure', async () => {
  const { loadSharedPdfEngine } = await import('./pdf-engine-loader');
  const first = loadSharedPdfEngine();
  const second = loadSharedPdfEngine();

  expect(second).toBe(first);
  await expect(first).rejects.toBe(failure);
  expect(createPdfiumEngine).toHaveBeenCalledTimes(1);
  expect(createPdfiumEngine).toHaveBeenCalledWith('https://pdf.example.test/pdfium/pdfium.wasm', {});
  expect(loadSharedPdfEngine()).toBe(first);
});
