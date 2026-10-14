/**
 * The Repo page (and a parked session) reads files from the project's git
 * mirror through the `project-ref` source. A workbook opened there failed with
 * "Server URL not ready — sandbox is still loading": the spreadsheet previewer
 * read the repo path through the session runtime, and no session is behind
 * this page. Every runtime file call here throws, so a previewer that reaches
 * for a session fails this test.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { prerender } from 'react-dom/static';

const runtimeCalls: string[] = [];
const realRuntime = await import('@/features/files/api/runtime-files');
const refuse = (name: string) => async () => {
  runtimeCalls.push(name);
  throw new Error('[kortix-runtime] Server URL not ready — sandbox is still loading');
};
mock.module('@/features/files/api/runtime-files', () => ({
  ...realRuntime,
  readFileAsBlob: refuse('readFileAsBlob'),
  readFile: refuse('readFile'),
  uploadFile: refuse('uploadFile'),
  downloadFile: refuse('downloadFile'),
}));

const WORKBOOK = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

// The git-ref hooks read through React Query, which a static prerender never
// resolves. These stand in for `GET /files/content` and `GET /files/raw`.
const blobRequests: Array<string | null> = [];
mock.module('@/features/project-files/hooks/use-binary-blob', () => ({
  useBinaryBlob: (path: string | null) => {
    blobRequests.push(path);
    return { blobUrl: path ? 'blob:repo/workbook' : null, blob: path ? WORKBOOK : null, isLoading: false, error: null };
  },
}));
const realContent = await import('@/features/project-files/hooks/use-file-content');
mock.module('@/features/project-files/hooks/use-file-content', () => ({
  ...realContent,
  useFileContent: (path: string | null) => ({
    data: path ? { type: 'binary', content: 'UEsDBA==', encoding: 'base64', mimeType: WORKBOOK.type } : undefined,
    isLoading: false,
    error: null,
    refetch: async () => undefined,
  }),
}));

const xlsxProps: Array<{ filePath?: string }> = [];
mock.module('@/features/file-renderers/xlsx/xlsx-renderer', () => ({
  isBlobUrl: (p: string) => p.startsWith('blob:'),
  XlsxRenderer: (props: { filePath?: string }) => {
    xlsxProps.push(props);
    return createElement('div', { 'data-xlsx-src': props.filePath });
  },
}));

const { ProjectFilesProvider } = await import('./context');
const { useProjectFileSource } = await import('./file-source');
const { FileSourceProvider } = await import('@/features/file-viewer/file-source');
const { FileContentRenderer } = await import('@/features/file-viewer/file-content-renderer');

function RepoViewer({ filePath }: { filePath: string }): ReactNode {
  const source = useProjectFileSource();
  return (
    <FileSourceProvider value={source}>
      <FileContentRenderer filePath={filePath} />
    </FileSourceProvider>
  );
}

async function render(filePath: string): Promise<string> {
  const { prelude } = await prerender(
    <ProjectFilesProvider value={{ projectId: 'project-1', ref: 'main' }}>
      <RepoViewer filePath={filePath} />
    </ProjectFilesProvider>,
  );
  return new Response(prelude).text();
}

afterEach(() => {
  runtimeCalls.length = 0;
  blobRequests.length = 0;
  xlsxProps.length = 0;
});

describe('Repo viewer without a session runtime', () => {
  test('a workbook opens from the git bytes, never a sandbox path', async () => {
    const html = await render('sales/forecast.xlsx');

    expect(blobRequests).toContain('sales/forecast.xlsx');
    expect(xlsxProps.map((p) => p.filePath)).toEqual(['blob:repo/workbook']);
    expect(html).toContain('data-xlsx-src="blob:repo/workbook"');
    expect(runtimeCalls).toEqual([]);
  });
});
