import { describe, expect, test } from 'bun:test';
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
 * document satisfies the component's DOM guard.
 */
(globalThis as { document?: unknown }).document = new Window().document;

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
