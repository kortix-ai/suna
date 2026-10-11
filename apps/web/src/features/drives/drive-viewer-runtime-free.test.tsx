/**
 * The project's Files viewer reads and saves through the drive source only.
 * A workbook uploaded to Files once opened with "Server URL not ready —
 * sandbox is still loading": the spreadsheet previewer read the file as a
 * sandbox path through whichever session happened to be selected. Every
 * runtime file call here throws, so any previewer that reaches for a session
 * fails this test.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { prerender } from 'react-dom/static';

const runtimeCalls: string[] = [];
const realRuntime = await import('@/features/files/api/runtime-files');
const refuse = (name: string) => async () => {
  runtimeCalls.push(name);
  throw new Error('[opencode-sdk] Server URL not ready — sandbox is still loading');
};
mock.module('@/features/files/api/runtime-files', () => ({
  ...realRuntime,
  readFileAsBlob: refuse('readFileAsBlob'),
  readFile: refuse('readFile'),
  uploadFile: refuse('uploadFile'),
  downloadFile: refuse('downloadFile'),
}));

const xlsxProps: Array<{ filePath?: string }> = [];
mock.module('@/features/file-renderers/xlsx/xlsx-renderer', () => ({
  isBlobUrl: (p: string) => p.startsWith('blob:'),
  XlsxRenderer: (props: { filePath?: string }) => {
    xlsxProps.push(props);
    return createElement('div', { 'data-xlsx-src': props.filePath });
  },
}));
const sqliteProps: Array<{ bytes?: Blob | null; onSave?: (file: File) => Promise<unknown> }> = [];
mock.module('@/features/file-renderers/sqlite-renderer', () => ({
  SqliteRenderer: (props: { bytes?: Blob | null; onSave?: (file: File) => Promise<unknown> }) => {
    sqliteProps.push(props);
    return createElement('div', { 'data-sqlite': props.bytes ? 'bytes' : 'path' });
  },
}));

const { FileSourceProvider } = await import('@/features/file-viewer/file-source');
const { FileContentRenderer } = await import('@/features/file-viewer/file-content-renderer');
import type { FileSource } from '@/features/file-viewer/file-source';

const WORKBOOK = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

function driveLikeSource(saved: Array<{ path: string; file: File }>): FileSource & { blobRequests: Array<string | null> } {
  const blobRequests: Array<string | null> = [];
  return {
    id: 'drive-test',
    bytesOnly: true,
    blobRequests,
    useFileContent: (path) => ({
      data: path ? { type: 'binary', content: 'UEsDBA==', encoding: 'base64', mimeType: WORKBOOK.type } : undefined,
      isLoading: false,
      error: null,
      refetch: async () => undefined,
    }),
    useBinaryBlob: (path) => {
      blobRequests.push(path);
      return { blobUrl: path ? 'blob:drive/workbook' : null, blob: path ? WORKBOOK : null, isLoading: false, error: null };
    },
    download: async () => undefined,
    upload: async () => {
      throw new Error('the viewer must save with the conditional save, not a blind upload');
    },
    save: async (path, file) => {
      saved.push({ path, file });
    },
  };
}

async function render(source: FileSource, filePath: string): Promise<string> {
  const { prelude } = await prerender(
    <FileSourceProvider value={source}>
      <FileContentRenderer filePath={filePath} />
    </FileSourceProvider>,
  );
  return new Response(prelude).text();
}

afterEach(() => {
  runtimeCalls.length = 0;
  xlsxProps.length = 0;
  sqliteProps.length = 0;
});

describe('Files viewer without a session runtime', () => {
  test('a workbook opens from the drive bytes, never a sandbox path', async () => {
    const source = driveLikeSource([]);
    const html = await render(source, 'Users/admin/tunnel-integrity.xlsx');

    expect(source.blobRequests).toContain('Users/admin/tunnel-integrity.xlsx');
    expect(xlsxProps.map((p) => p.filePath)).toEqual(['blob:drive/workbook']);
    expect(html).toContain('data-xlsx-src="blob:drive/workbook"');
    expect(runtimeCalls).toEqual([]);
  });

  test('a SQLite database reads the drive bytes and saves through the source', async () => {
    const saved: Array<{ path: string; file: File }> = [];
    const html = await render(driveLikeSource(saved), 'Company/data.sqlite');

    expect(html).toContain('data-sqlite="bytes"');
    const props = sqliteProps.at(-1)!;
    expect(props.bytes).toBe(WORKBOOK);
    await props.onSave!(new File(['x'], 'data.sqlite'));
    expect(saved.map((s) => s.path)).toEqual(['Company/data.sqlite']);
    expect(runtimeCalls).toEqual([]);
  });

  test('HTML opens as source: the rendered frame is served by a sandbox', async () => {
    const source: FileSource = {
      ...driveLikeSource([]),
      useFileContent: () => ({
        data: { type: 'text', content: '<h1>hi</h1>' },
        isLoading: false,
        error: null,
        refetch: async () => undefined,
      }),
    };
    const html = await render(source, 'Company/page.html');

    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('Starting preview server');
    expect(html).toContain('hi');
    expect(runtimeCalls).toEqual([]);
  });
});
