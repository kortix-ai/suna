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

function view(path: string) {
  return renderToStaticMarkup(<FileSourceProvider value={source}><FileContentRenderer filePath={path} /></FileSourceProvider>);
}

describe('file content renderer dispatch', () => {
  test('JSON exposes the tree toggle and starts in source mode', () => {
    const html = view('/workspace/data.json');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="hardcodedUi.i18nComplete.text4f50bda41e87"');
  });
  test('image, PDF, code, markdown, and unknown files retain their initial render states', () => {
    const states = ['/workspace/a.png', '/workspace/a.pdf', '/workspace/a.ts', '/workspace/a.md', '/workspace/a.unknown'].map(view);
    expect(states.map((html) => html.includes('animate-spinner-orbit'))).toEqual([false, true, false, false, false]);
    expect(states[3]).toContain('aria-pressed="true"');
    expect(states[2]).not.toContain('aria-pressed="true"');
    expect(states[4]).not.toContain('aria-pressed="true"');
  });
});
