import { describe, expect, mock, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

mock.module('@/lib/utils/theme', () => ({
  THEME: { light: {}, dark: {} },
  withAlpha: () => '',
}));
const { generatePdfJsHtml } = await import('./file-preview-html');

function preview() {
  const loading = { style: { display: '' } };
  const error = { style: { display: 'none' }, textContent: 'Failed to load PDF' };
  const container = { appendChild: mock(() => {}) };
  const document = {
    getElementById: (id: string) => ({ loading, error, container })[id],
    createElement: () => ({ getContext: () => ({}), width: 0, height: 0 }),
  };
  const window = { innerWidth: 400, onload: () => {} };
  const context = { document, window, atob, Uint8Array, console: { error: mock(() => {}) } };
  const script = generatePdfJsHtml('JVBERg==', false).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error('Missing PDF script');
  return { loading, error, container, context, script };
}

function library() {
  const render = mock(() => ({ promise: Promise.resolve() }));
  const getPage = mock(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
    render,
  }));
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: mock(() => ({ promise: Promise.resolve({ numPages: 1, getPage }) })),
    getPage,
    render,
  };
}

describe('PDF WebView script', () => {
  test('shows the existing error instead of loading forever when the CDN fails', () => {
    const p = preview();
    runInNewContext(p.script, p.context);
    p.context.window.onload();
    expect(p.loading.style.display).toBe('none');
    expect(p.error.style.display).toBe('block');
    expect(p.error.textContent).toBe('Failed to load PDF library');
  });

  test('renders immediately when pdf.js is available, with safe worker settings', async () => {
    const p = preview();
    const pdfjsLib = library();
    await runInNewContext(p.script, { ...p.context, pdfjsLib });
    expect(pdfjsLib.GlobalWorkerOptions.workerSrc).toBe('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js');
    expect(pdfjsLib.getDocument).toHaveBeenCalledWith({ data: new Uint8Array([37, 80, 68, 70]), isEvalSupported: false });
    expect(pdfjsLib.getPage).toHaveBeenCalledWith(1);
    expect(pdfjsLib.render).toHaveBeenCalledTimes(1);
    expect(p.container.appendChild).toHaveBeenCalledTimes(2);
    expect(p.loading.style.display).toBe('none');
    expect(p.error.style.display).toBe('none');
  });

  test('retries initialization on load if the library becomes available', async () => {
    const p = preview();
    const context: typeof p.context & { pdfjsLib?: ReturnType<typeof library> } = { ...p.context };
    runInNewContext(p.script, context);
    context.pdfjsLib = library();
    await context.window.onload();
    expect(context.pdfjsLib.getDocument).toHaveBeenCalledTimes(1);
    expect(p.container.appendChild).toHaveBeenCalledTimes(2);
    expect(p.error.style.display).toBe('none');
  });

  test('retains the render error fallback for invalid PDF data', async () => {
    const p = preview();
    const pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => { throw new Error('Invalid PDF'); } };
    await runInNewContext(p.script, { ...p.context, pdfjsLib });
    expect(p.loading.style.display).toBe('none');
    expect(p.error.style.display).toBe('block');
    expect(p.error.textContent).toBe('Failed to load PDF');
  });
});
