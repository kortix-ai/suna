import { describe, expect, test } from 'bun:test';
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
  const imageSource = {
    ...source,
    useFileContent: () => ({ data: { type: 'binary', encoding: 'base64', mimeType: 'image/png', content: 'iVBORw0KGgo=' }, isLoading: false, error: null, refetch: async () => undefined }),
  } as FileSource;
  const fullScreen = (path: string) =>
    renderToStaticMarkup(<FileSourceProvider value={imageSource}><FileContentRenderer filePath={path} showCaption /></FileSourceProvider>);
  const reset = () => useFilePreviewStore.setState({ isOpen: false, filePath: null, lineNumber: undefined, captions: {} });

  test('an image opened without caption data renders as before', () => {
    expect(fullScreen('/workspace/output/images/plain.png')).not.toContain('data-file-caption');
  });

  test('an image opened with its caption shows the prompt and the model under it', () => {
    useFilePreviewStore.getState().openPreview('/workspace/output/images/fox.png', undefined, { text: 'A fox in a shuttle', model: 'codex/gpt-image-2' });
    try {
      for (const path of ['/workspace/output/images/fox.png', 'output/images/fox.png']) {
        const html = fullScreen(path);
        expect(html).toContain('data-file-caption');
        expect(html).toContain('A fox in a shuttle');
        expect(html).toContain('codex/gpt-image-2');
      }
      // Another file, opened in the same viewer, carries no caption.
      expect(fullScreen('/workspace/output/images/other.png')).not.toContain('data-file-caption');
      expect(view('/workspace/notes.ts')).not.toContain('data-file-caption');
    } finally {
      reset();
    }
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
