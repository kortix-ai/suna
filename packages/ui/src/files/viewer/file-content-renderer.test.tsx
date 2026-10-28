import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileSourceProvider, type FileSource } from './file-source';
import { FileContentRenderer } from './file-content-renderer';
import { useFilePreviewStore } from '../../internal/stores/file-preview-store';

const source: FileSource = {
  id: 'characterization',
  useFileContent: () => ({ data: { type: 'text', content: '{"nested":{"ok":true}}' }, isLoading: false, error: null, refetch: async () => undefined }),
  useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
  download: async () => undefined,
  upload: async () => undefined,
};

/** Mounts `node` in a happy-dom document, hands it to `run`, then restores the globals. */
async function inDom(node: ReactElement, run: (container: HTMLElement, act: (fn: () => Promise<void>) => Promise<void>) => Promise<void>) {
  const win = new Window();
  const globals: Record<string, unknown> = {
    window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, Element: win.Element,
    Node: win.Node, MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const container = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const root = createRoot(container);
  const step = async (fn: () => Promise<void>) => { await act(fn); };
  try {
    await act(async () => root.render(node));
    await run(container, step);
  } finally {
    await act(async () => root.unmount());
    await win.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function view(path: string, targetLine?: number) {
  return renderToStaticMarkup(<FileSourceProvider value={source}><FileContentRenderer filePath={path} targetLine={targetLine} /></FileSourceProvider>);
}

describe('file content renderer dispatch', () => {
  test('JSON exposes the tree toggle and starts in source mode', () => {
    const html = view('/workspace/data.json');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Tree view"');
  });
  test('image, PDF, code, markdown, and unknown files retain their initial render states', () => {
    const states = ['/workspace/a.png', '/workspace/a.pdf', '/workspace/a.ts', '/workspace/a.md', '/workspace/a.unknown'].map(view);
    expect(states.map((html) => html.includes('animate-spinner-orbit'))).toEqual([false, true, false, false, false]);
    expect(states[3]).toContain('aria-pressed="true"');
    expect(states[2]).not.toContain('aria-pressed="true"');
    expect(states[4]).not.toContain('aria-pressed="true"');
  });
});

// KRTX-1723: a content-search match opens its file at the matched line. A
// rendered HTML page and the CSV table have no lines to scroll to.
describe('file content renderer at a target line', () => {
  test('HTML opens as source, not the rendered page', () => {
    expect(view('/workspace/a.html')).toContain('aria-label="View source" aria-pressed="true"');
    const atLine = view('/workspace/a.html', 3);
    expect(atLine).toContain('aria-label="Preview" aria-pressed="false"');
    expect(atLine).not.toContain('aria-label="View source"');
  });
  test('CSV opens in the code editor, not the table', () => {
    // The table is a lazy renderer: a first paint shows its loading fallback.
    expect(view('/workspace/a.csv')).toContain('animate-spinner-orbit');
    const atLine = view('/workspace/a.csv', 2);
    expect(atLine).not.toContain('animate-spinner-orbit');
    expect(atLine).toContain('class="relative flex flex-col h-full"');
  });
});

// The image card opens a generated image with its prompt and the model that
// made it (`openPreview(path, line, caption)`). Only a full-screen viewer
// (`showCaption`: the preview modal, the panel's file preview) shows it; a
// Files grid tile and every other embedded renderer never do.
describe('the full-screen view shows the caption section only when caption data is given', () => {
  // One result object, as react-query hands back while the data is unchanged.
  const pngRead = { data: { type: 'binary', encoding: 'base64', mimeType: 'image/png', content: 'iVBORw0KGgo=' }, isLoading: false, error: null, refetch: async () => undefined };
  const imageSource = { ...source, useFileContent: () => pngRead } as FileSource;
  const fullScreen = (path: string) =>
    renderToStaticMarkup(<FileSourceProvider value={imageSource}><FileContentRenderer filePath={path} showCaption /></FileSourceProvider>);
  const reset = () => useFilePreviewStore.setState({ isOpen: false, filePath: null, lineNumber: undefined, captions: {} });

  test('an image opened without caption data renders as before', () => {
    expect(fullScreen('/workspace/output/images/plain.png')).not.toContain('data-file-caption');
  });

  // Replaces "an image opened with its caption shows the prompt and the model under it" (Jay,
  // 2026-10-28): the caption is hidden by default and opens from the zoom shelf's ⓘ toggle.
  test('the caption is hidden until the info button is pressed', async () => {
    useFilePreviewStore.getState().openPreview('/workspace/output/images/fox.png', undefined, { text: 'A fox in a shuttle', model: 'codex/gpt-image-2' });
    try {
      for (const path of ['/workspace/output/images/fox.png', 'output/images/fox.png']) {
        const html = fullScreen(path);
        expect(html).not.toContain('data-file-caption');
        expect(html).not.toContain('A fox in a shuttle');
        // The toggle sits right after rotate, off, named in the viewer's language.
        expect(html).toMatch(/aria-label="Rotate[^"]*"[\s\S]*?<button[^>]*aria-label="Image details" aria-pressed="false"[^>]*data-image-info=""/);
      }
      await inDom(<FileSourceProvider value={imageSource}><FileContentRenderer filePath="/workspace/output/images/fox.png" showCaption /></FileSourceProvider>, async (container, act) => {
        const info = () => container.querySelector('[data-image-info]') as HTMLButtonElement;
        expect(container.querySelector('[data-file-caption]')).toBeNull();
        await act(async () => info().click());
        expect(info().getAttribute('aria-pressed')).toBe('true');
        expect(container.querySelector('[data-file-caption]')?.textContent).toContain('A fox in a shuttle');
        expect(container.querySelector('[data-file-caption]')?.textContent).toContain('codex/gpt-image-2');
        await act(async () => info().click());
        expect(info().getAttribute('aria-pressed')).toBe('false');
        expect(container.querySelector('[data-file-caption]')).toBeNull();
      });
      // Another file, opened in the same viewer, carries no caption.
      expect(fullScreen('/workspace/output/images/other.png')).not.toContain('data-file-caption');
      expect(view('/workspace/notes.ts')).not.toContain('data-file-caption');
    } finally {
      reset();
    }
  });

  test('the info button is absent without caption data', () => {
    const html = fullScreen('/workspace/output/images/plain.png');
    expect(html).toContain('<img');
    expect(html).not.toContain('data-image-info');
    expect(html).not.toContain('Image details');
  });

  test('a Files grid tile of a captioned image shows no caption', () => {
    useFilePreviewStore.getState().openPreview('/workspace/output/images/fox.png', undefined, { text: 'A fox in a shuttle', model: 'codex/gpt-image-2' });
    try {
      // `FileThumbnail` renders the image with exactly these props.
      const tile = renderToStaticMarkup(
        <FileSourceProvider value={imageSource}>
          <FileContentRenderer filePath="/workspace/output/images/fox.png" readOnly showHeader={false} imageControls="none" />
        </FileSourceProvider>,
      );
      expect(tile).toContain('<img');
      expect(tile).not.toContain('data-file-caption');
      expect(tile).not.toContain('A fox in a shuttle');
    } finally {
      reset();
    }
  });
});
