import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';

import { readFile, readFileAsBlob } from './runtime-files';

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

function stubRaw(suffix: string, bytes: Uint8Array) {
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
