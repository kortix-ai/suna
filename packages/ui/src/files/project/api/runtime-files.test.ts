import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';

import {
  FILE_LIST_PAGE_SIZE,
  listFiles,
  readFile,
  readFileAsBlob,
  searchFileContents,
  searchFiles,
} from './runtime-files';

// Byte-level responses for /files/raw and JSON for /files/content, per-URL.
let routes: Record<string, { status: number; body: BodyInit; contentType: string }> = {};
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  routes = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
    if (!hit) return new Response('no route stubbed', { status: 500 });
    return new Response(hit[1].body, {
      status: hit[1].status,
      headers: { 'content-type': hit[1].contentType },
    });
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

afterEach(() => {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

const PNG_LIKE_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0xff, 0xfe, 0xfa, 0xde,
]);

function stubRaw(suffix: string, bytes: Uint8Array<ArrayBuffer>) {
  routes[suffix] = { status: 200, body: bytes, contentType: 'application/octet-stream' };
}

test('a png reads as base64 image content from the raw byte route', async () => {
  stubRaw('/files/raw', PNG_LIKE_BYTES);
  const result = await readFile('P1', 'main', '/workspace/assets/logo.png');
  expect(calls.some((c) => c.includes('/files/raw?'))).toBe(true);
  expect(calls.some((c) => c.includes('path=assets%2Flogo.png'))).toBe(true);
  expect(result).toEqual({
    type: 'binary',
    content: Buffer.from(PNG_LIKE_BYTES).toString('base64'),
    encoding: 'base64',
    mimeType: 'image/png',
  });
});

test('a pdf reads as base64 content', async () => {
  stubRaw('/files/raw', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
  const result = await readFile('P1', 'main', '/workspace/doc.pdf');
  expect(result.type).toBe('binary');
  expect(result.encoding).toBe('base64');
  expect(result.mimeType).toBe('application/pdf');
});

test('docx reports binary without fetching content the renderers never read', async () => {
  stubRaw('/files/raw', PNG_LIKE_BYTES);
  const result = await readFile('P1', 'main', '/workspace/report.docx');
  expect(result).toEqual({ type: 'binary', content: '', mimeType: 'application/octet-stream' });
  expect(calls).toEqual([]);
});

test('a heic photo reports binary without fetching — the blob pipeline owns it', async () => {
  const result = await readFile('P1', 'main', '/workspace/photo.heic');
  expect(result).toEqual({ type: 'binary', content: '', mimeType: 'application/octet-stream' });
  expect(calls).toEqual([]);
});

test('a text file still reads the JSON content route', async () => {
  routes['/files/content'] = {
    status: 200,
    body: JSON.stringify({ path: 'notes.md', ref: 'main', content: '# hi' }),
    contentType: 'application/json',
  };
  const result = await readFile('P1', 'main', '/workspace/notes.md');
  expect(calls.some((c) => c.includes('/files/content'))).toBe(true);
  expect(result).toEqual({ type: 'text', content: '# hi' });
});

test('an extensionless text file (LICENSE) reads bytes and classifies as text', async () => {
  stubRaw('/files/raw', new Uint8Array([0x4d, 0x49, 0x54, 0x20, 0x6c, 0x69, 0x63])); // "MIT lic"
  const result = await readFile('P1', 'main', '/workspace/LICENSE');
  expect(result).toEqual({
    type: 'text',
    content: 'MIT lic',
    mimeType: 'text/plain; charset=utf-8',
  });
});

test('an unknown-extension binary file (data.bin) reports binary, never mojibake text', async () => {
  stubRaw('/files/raw', PNG_LIKE_BYTES);
  const result = await readFile('P1', 'main', '/workspace/data.bin');
  expect(result.type).toBe('binary');
  expect(result.encoding).toBeUndefined();
});

test('an svg still reads as text source, matching the sandbox daemon', async () => {
  stubRaw('/files/raw', new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e])); // "<svg>"
  const result = await readFile('P1', 'main', '/workspace/brand.svg');
  expect(result.type).toBe('text');
  expect(result.content).toBe('<svg>');
});

test('readFileAsBlob returns the exact bytes of a binary file', async () => {
  stubRaw('/files/raw', PNG_LIKE_BYTES);
  const blob = await readFileAsBlob('P1', 'main', '/workspace/assets/logo.png');
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_LIKE_BYTES);
});

test('a 404 from the raw route surfaces as a not-found error', async () => {
  routes['/files/raw'] = { status: 404, body: 'File not found', contentType: 'text/plain' };
  await expect(readFile('P1', 'main', '/workspace/logo.png')).rejects.toThrow(/File not found|404/i);
});

// KRTX-1723: the tree was built from the recursive list, which stops at 1,000
// files, so every folder that sorts after file 1,000 was missing.
test('listFiles reads one folder level (depth=1) and maps folders and files', async () => {
  routes['/projects/P1/files'] = {
    status: 200,
    body: JSON.stringify({
      entries: [
        { path: 'src/lib', type: 'directory' },
        { path: 'src/index.ts', type: 'file' },
      ],
      truncated: false,
      next_cursor: null,
    }),
    contentType: 'application/json',
  };
  const { nodes, nextCursor } = await listFiles('P1', 'main', '/workspace/src');
  const url = new URL(calls[0]);
  expect(url.searchParams.get('depth')).toBe('1');
  expect(url.searchParams.get('path')).toBe('src');
  expect(url.searchParams.get('ref')).toBe('main');
  expect(nextCursor).toBeNull();
  expect(nodes).toEqual([
    { name: 'lib', path: '/workspace/src/lib', absolute: '/workspace/src/lib', type: 'directory', ignored: false },
    { name: 'index.ts', path: '/workspace/src/index.ts', absolute: '/workspace/src/index.ts', type: 'file', ignored: false },
  ]);
});

test('listFiles at the root lists a folder that sorts after 1,000 files', async () => {
  routes['/projects/P1/files'] = {
    status: 200,
    body: JSON.stringify({
      entries: [
        { path: 'README.md', type: 'file' },
        { path: 'a', type: 'directory' },
        { path: 'z', type: 'directory' },
      ],
      truncated: false,
    }),
    contentType: 'application/json',
  };
  const { nodes } = await listFiles('P1', 'main', '/workspace');
  expect(new URL(calls[0]).searchParams.has('path')).toBe(false);
  expect(nodes.map((n) => `${n.type}:${n.path}`)).toEqual([
    'directory:/workspace/a',
    'directory:/workspace/z',
    'file:/workspace/README.md',
  ]);
});

// KRTX-1723: a folder over one page shows its first 500 entries and "Load more".
test('listFiles asks for one page and returns the cursor of the next', async () => {
  routes['/projects/P1/files'] = {
    status: 200,
    body: JSON.stringify({
      entries: [{ path: 'a/f0000.txt', type: 'file' }],
      truncated: true,
      next_cursor: 'CURSOR-2',
    }),
    contentType: 'application/json',
  };
  const page = await listFiles('P1', 'main', '/workspace/a');
  const url = new URL(calls[0]);
  expect(url.searchParams.get('limit')).toBe(String(FILE_LIST_PAGE_SIZE));
  expect(FILE_LIST_PAGE_SIZE).toBe(500);
  expect(url.searchParams.has('cursor')).toBe(false);
  expect(page.nextCursor).toBe('CURSOR-2');
});

test('listFiles sends the cursor for the next page', async () => {
  routes['/projects/P1/files'] = {
    status: 200,
    body: JSON.stringify({ entries: [{ path: 'a/f1199.txt', type: 'file' }], truncated: false, next_cursor: null }),
    contentType: 'application/json',
  };
  const page = await listFiles('P1', 'main', '/workspace/a', 'CURSOR-2');
  const url = new URL(calls[0]);
  expect(url.searchParams.get('cursor')).toBe('CURSOR-2');
  expect(url.searchParams.get('path')).toBe('a');
  expect(page).toEqual({
    nodes: [
      { name: 'f1199.txt', path: '/workspace/a/f1199.txt', absolute: '/workspace/a/f1199.txt', type: 'file', ignored: false },
    ],
    nextCursor: null,
    truncated: false,
  });
});

test('an API without next_cursor reads as the last page', async () => {
  routes['/projects/P1/files'] = {
    status: 200,
    body: JSON.stringify({ entries: [], truncated: false }),
    contentType: 'application/json',
  };
  const page = await listFiles('P1', 'main', '/workspace');
  expect(page.nextCursor).toBeNull();
  expect(page.truncated).toBe(false);
});

// An API older than paging ignores `limit`: it cuts the folder at 5,000 and
// sends no cursor. The page must say it is cut, never read as complete.
test('a cut response without next_cursor reads as truncated, with no next page', async () => {
  routes['/projects/P1/files'] = {
    status: 200,
    body: JSON.stringify({ entries: [{ path: 'a/f0000.txt', type: 'file' }], truncated: true }),
    contentType: 'application/json',
  };
  const page = await listFiles('P1', 'main', '/workspace/a');
  expect(page.nextCursor).toBeNull();
  expect(page.truncated).toBe(true);
});

// KRTX-1723: the Files page had no search; a file past the old 1,000-file cut
// could be neither seen nor found.
test('searchFiles asks the server by filename and returns workspace paths', async () => {
  routes['/projects/P1/files/search'] = {
    status: 200,
    body: JSON.stringify({ query: 'last', ref: 'main', content_search: false, results: [{ path: 'z/last.txt' }] }),
    contentType: 'application/json',
  };
  const paths = await searchFiles('P1', 'main', ' last ', { limit: 30 });
  const url = new URL(calls[0]);
  expect(url.searchParams.get('q')).toBe('last');
  expect(url.searchParams.get('ref')).toBe('main');
  expect(url.searchParams.get('limit')).toBe('30');
  expect(url.searchParams.has('content')).toBe(false);
  expect(paths).toEqual(['/workspace/z/last.txt']);
});

test('searchFiles sends nothing for a blank query', async () => {
  expect(await searchFiles('P1', 'main', '   ')).toEqual([]);
  expect(calls).toHaveLength(0);
});

// KRTX-1723: content search finds a line in a file; choosing it opens that line.
test('searchFileContents asks the server for a content search and keeps the line', async () => {
  routes['/projects/P1/files/search'] = {
    status: 200,
    body: JSON.stringify({
      query: 'last',
      ref: 'main',
      content_search: true,
      results: [{ path: 'z/last.txt', line_number: 1, line_text: 'last' }],
    }),
    contentType: 'application/json',
  };
  const matches = await searchFileContents('P1', 'main', ' last ', { limit: 50 });
  const url = new URL(calls[0]);
  expect(url.searchParams.get('q')).toBe('last');
  expect(url.searchParams.get('content')).toBe('1');
  expect(url.searchParams.get('ref')).toBe('main');
  expect(url.searchParams.get('limit')).toBe('50');
  expect(matches).toEqual([{ path: '/workspace/z/last.txt', lineNumber: 1, lineText: 'last' }]);
});

test('searchFileContents sends nothing for a blank query', async () => {
  expect(await searchFileContents('P1', 'main', '  ')).toEqual([]);
  expect(calls).toHaveLength(0);
});
