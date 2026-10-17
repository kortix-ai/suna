import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileSourceProvider, type FileSource } from './file-source';
import { FileContentRenderer } from './file-content-renderer';

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
