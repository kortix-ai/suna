import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilePreviewModal } from './file-preview-modal';
import type { FileSource } from './file-source';

const source: FileSource = {
  id: 'modal-characterization',
  useFileContent: () => ({
    data: { type: 'text', content: '# hello' },
    isLoading: false,
    error: null,
    refetch: async () => undefined,
  }),
  useBinaryBlob: () => ({ blobUrl: null, blob: null, isLoading: false, error: null }),
  download: async () => undefined,
  upload: async () => undefined,
};

/**
 * FilePreviewModal portals to <body> in its full-screen mode, which the server
 * renderer cannot do, so the case renders the embedded (session side panel)
 * mode: the same component, the same shared toolbar, no portal. The happy-dom
 * document satisfies the component's DOM guard. Bun shares globals across the
 * files of one run, so the previous value is restored when this file ends.
 */
const realDocument = (globalThis as { document?: unknown }).document;
(globalThis as { document?: unknown }).document = new Window().document;
afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

describe('file preview modal source toggle', () => {
  test('markdown opens previewed, and the toggle is pressed while the preview shows', () => {
    const html = renderToStaticMarkup(
      <FilePreviewModal
        selectedFilePath="/workspace/a.md"
        panelMode="viewer"
        filePathList={['/workspace/a.md']}
        currentFileIndex={0}
        onClose={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        source={source}
        HistoryContent={() => null}
        renderFileIcon={() => null}
        embedded
      />,
    );

    // The polarity file-header pins through file-content-renderer.test.tsx:
    // `aria-pressed` follows the markdown preview, not the source view.
    const toggle = (html.match(/<button[^>]*>/g) ?? []).find((tag) =>
      tag.includes('aria-label="View source"'),
    );
    expect(toggle).toBeDefined();
    expect(toggle).toContain('aria-pressed="true"');
  });
});

describe('file preview modal header', () => {
  test('an editable file has one header: the path pill, one Download, no breadcrumb row', () => {
    const html = renderToStaticMarkup(
      <FilePreviewModal
        selectedFilePath="/workspace/skills/xlsx/scripts/run.py"
        panelMode="viewer"
        filePathList={['/workspace/skills/xlsx/scripts/run.py']}
        currentFileIndex={0}
        onClose={() => {}}
        onNext={() => {}}
        onPrev={() => {}}
        source={{
          ...source,
          editablePreview: true,
          Breadcrumbs: () => <nav data-breadcrumbs />,
        }}
        HistoryContent={() => null}
        renderFileIcon={() => null}
        embedded
      />,
    );

    expect(html).toContain('skills / xlsx / scripts /');
    expect(html).not.toContain('data-breadcrumbs');
    expect(html.match(/aria-label="Download"/g) ?? []).toHaveLength(1);
  });
});
