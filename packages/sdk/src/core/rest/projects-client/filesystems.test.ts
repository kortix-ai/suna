import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import {
  createProjectFilesystem,
  deleteProjectFilesystem,
  deleteProjectFilesystemFile,
  listProjectFilesystemFiles,
  listProjectFilesystems,
  readProjectFilesystemFile,
  writeProjectFilesystemFile,
} from './filesystems';

interface Seen {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
  headers: Record<string, string>;
}

let seen: Seen[] = [];
let reply: (url: string) => Response = () =>
  new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  seen = [];
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    const href = String(url);
    const headers: Record<string, string> = {};
    new Headers(options.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    seen.push({ url: href, method: options.method ?? 'GET', body: options.body, headers });
    return reply(href);
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });

test('listProjectFilesystems reads the project-scoped collection', async () => {
  reply = () =>
    new Response(JSON.stringify({ filesystems: [{ name: 'notes' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const out = await listProjectFilesystems('proj-1');
  expect(seen[0]?.method).toBe('GET');
  expect(seen[0]?.url).toContain('/projects/proj-1/filesystems');
  expect(out).toEqual([{ name: 'notes' } as never]);
});

test('createProjectFilesystem posts the name', async () => {
  await createProjectFilesystem('proj-1', { name: 'notes', description: 'shared' });
  expect(seen[0]?.method).toBe('POST');
  expect(JSON.parse(String(seen[0]?.body))).toMatchObject({ name: 'notes', description: 'shared' });
});

/**
 * The one that matters. A file is BYTES, and the JSON client would wrap a
 * string in quotes and stamp application/json — silently corrupting every file
 * the SDK writes. The write path has to bypass JSON encoding entirely.
 */
test('writeProjectFilesystemFile sends RAW bytes, never JSON-wrapped', async () => {
  const content = '# Plan\n\nhand this to the next agent.\n';
  await writeProjectFilesystemFile('proj-1', 'notes', 'notes/2026/plan.md', content, {
    contentType: 'text/markdown',
  });

  const req = seen[0]!;
  expect(req.method).toBe('PUT');
  // The path travels as a query parameter: an OpenAPI {path} matches one
  // segment, so a nested path in the URL never reaches the route.
  expect(req.url).toContain('/projects/proj-1/filesystems/notes/files/content');
  expect(decodeURIComponent(req.url)).toContain('path=notes/2026/plan.md');
  expect(req.headers['content-type']).toBe('text/markdown');

  const sentBytes = new Uint8Array(
    req.body instanceof Uint8Array ? req.body : new TextEncoder().encode(String(req.body)),
  );
  expect(new TextDecoder().decode(sentBytes)).toBe(content);
  // The JSON client would have produced `"# Plan\n..."` — quoted and escaped.
  expect(new TextDecoder().decode(sentBytes).startsWith('"')).toBe(false);
});

test('writeProjectFilesystemFile accepts binary and defaults its content type', async () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  await writeProjectFilesystemFile('proj-1', 'notes', 'blob.bin', bytes);
  const req = seen[0]!;
  expect(req.headers['content-type']).toBe('application/octet-stream');
  const sent = req.body instanceof Uint8Array ? req.body : new Uint8Array();
  expect(Array.from(sent)).toEqual([0, 1, 2, 253, 254, 255]);
});

test('readProjectFilesystemFile returns the bytes and the response metadata', async () => {
  reply = () =>
    new Response('hello bytes', {
      status: 200,
      headers: { 'content-type': 'text/plain', etag: '"abc123"' },
    });
  const out = await readProjectFilesystemFile('proj-1', 'notes', 'a.txt');
  expect(seen[0]?.method).toBe('GET');
  expect(decodeURIComponent(seen[0]?.url ?? '')).toContain('path=a.txt');
  expect(new TextDecoder().decode(out.bytes)).toBe('hello bytes');
  expect(out.contentType).toBe('text/plain');
  expect(out.sha256).toBe('abc123');
});

test('readProjectFilesystemFile exposes text() without a second request', async () => {
  reply = () => new Response('plain text', { status: 200 });
  const out = await readProjectFilesystemFile('proj-1', 'notes', 'a.txt');
  expect(out.text()).toBe('plain text');
  expect(seen.length).toBe(1);
});

test('listProjectFilesystemFiles passes a prefix through', async () => {
  reply = () =>
    new Response(JSON.stringify({ files: [{ path: 'notes/a.txt' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const out = await listProjectFilesystemFiles('proj-1', 'notes', { prefix: 'notes' });
  expect(decodeURIComponent(seen[0]?.url ?? '')).toContain('prefix=notes');
  expect(out).toEqual([{ path: 'notes/a.txt' } as never]);
});

test('delete helpers target the file and the filesystem', async () => {
  reply = () => new Response(null, { status: 204 });
  await deleteProjectFilesystemFile('proj-1', 'notes', 'a.txt');
  expect(seen[0]?.method).toBe('DELETE');
  expect(decodeURIComponent(seen[0]?.url ?? '')).toContain('files/content?path=a.txt');

  seen = [];
  await deleteProjectFilesystem('proj-1', 'notes');
  expect(seen[0]?.method).toBe('DELETE');
  expect(seen[0]?.url).toContain('/filesystems/notes');
  expect(seen[0]?.url).not.toContain('files/content');
});
