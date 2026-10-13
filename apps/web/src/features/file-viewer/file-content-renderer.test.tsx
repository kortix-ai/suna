import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileSourceProvider, type FileContentResult, type FileSource } from './file-source';
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

/** The same harness with a specific source — for the states the default text source can't reach. */
function viewWith(src: FileSource, path: string, targetLine?: number) {
  return renderToStaticMarkup(<FileSourceProvider value={src}><FileContentRenderer filePath={path} targetLine={targetLine} /></FileSourceProvider>);
}

function sourceWith(content: Partial<FileContentResult> = {}): FileSource {
  return {
    ...source,
    useFileContent: () => ({ data: undefined, isLoading: false, error: null, refetch: async () => undefined, ...content }),
  };
}

// KRTX-1772 characterization: the viewer notices. Every fallback state a
// file can sit in, rendered and asserted on its i18n strings — the category
// dispatch may be restructured, these states may not change shape.
describe('file viewer notices', () => {
  test('a waking sandbox shows the pending notice, not an error', () => {
    const html = viewWith(sourceWith({ error: new Error('sandbox not ready') }), '/workspace/a.md');
    expect(html).toContain('Waking up the workspace…');
    expect(html).toContain('The sandbox is starting. This file will load automatically.');
    expect(html).toContain('animate-spinner-orbit');
    expect(html).not.toContain('Failed to load file');
  });

  test('a plain failure shows the error skeleton with the message', () => {
    const html = viewWith(sourceWith({ error: new Error('boom') }), '/workspace/a.md');
    expect(html).toContain('Failed to load file');
    expect(html).toContain('boom');
  });

  test('a missing file shows the not-found notice — by error, by empty resolution, and for an unloaded blob category', () => {
    const byError = viewWith(sourceWith({ error: new Error('404 no such file') }), '/workspace/a.md');
    expect(byError).toContain('File not found');
    expect(byError).toContain('This file does not exist or may have been deleted.');
    expect(viewWith(sourceWith(), '/workspace/a.md')).toContain('File not found');
    expect(viewWith(source, '/workspace/a.docx')).toContain('File not found');
  });

  test('a binary payload with no renderer shows the binary fallback and a download', () => {
    const html = viewWith(sourceWith({ data: { type: 'binary', content: '' } }), '/workspace/a.unknown');
    expect(html).toContain('Binary file');
    expect(html).toContain('Download');
  });
});

// KRTX-1772 characterization: one first paint per category that the shared
// dispatch had no rendered case for. The lazy renderers all show the same
// spinner fallback on first paint; audio is not lazy and paints its element.
describe('file content renderer category first paints', () => {
  const blobSource: FileSource = {
    ...source,
    useBinaryBlob: () => ({ blobUrl: 'blob:mock', blob: new Blob(['bytes']), isLoading: false, error: null }),
  };

  test('blob categories show their lazy renderer once the blob lands', () => {
    const lazy = ['/workspace/a.docx', '/workspace/a.zip', '/workspace/a.mp4', '/workspace/a.pptx'].map(
      (path) => viewWith(blobSource, path),
    );
    expect(lazy.map((html) => html.includes('animate-spinner-orbit'))).toEqual([true, true, true, true]);
  });

  test('audio paints its element directly, no lazy chunk', () => {
    expect(viewWith(blobSource, '/workspace/a.mp3')).toContain('<audio');
  });

  test('xlsx, sqlite and a real base64 image spin on their lazy chunk', () => {
    expect(viewWith(source, '/workspace/a.xlsx')).toContain('animate-spinner-orbit');
    expect(viewWith(source, '/workspace/a.sqlite')).toContain('animate-spinner-orbit');
    const image = sourceWith({ data: { type: 'binary', content: 'aGk=', encoding: 'base64', mimeType: 'image/png' } });
    expect(viewWith(image, '/workspace/a.png')).toContain('animate-spinner-orbit');
  });
});

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
