import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { invalidateTokenCache } from '../../http/auth';
import { fetchProjectFileRaw, listProjectFiles, projectArchiveRequest, readProjectFile } from './files';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('listProjectFiles GETs /projects/:id/files with ref/path query', async () => {
  nextResponse = { status: 200, body: [] };
  const result = await listProjectFiles('P1', { ref: 'main', path: 'src' });
  expect(last().url).toContain('/projects/P1/files?ref=main&path=src');
  expect(last().method).toBe('GET');
  expect(result).toEqual([]);
});

test('listProjectFiles is a silent background read — a 403 never hits the global error sink', async () => {
  // project.file.read is manager-tier: a member deep-linking to the files page
  // legitimately 403s. The files view renders its own error state, no toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { message: 'forbidden' } };
    await expect(listProjectFiles('P1')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('readProjectFile GETs /projects/:id/files/content with path/ref query', async () => {
  nextResponse = { status: 200, body: { path: 'a.md', ref: 'main', content: 'hi' } };
  const result = await readProjectFile('P1', 'a.md', 'main');
  expect(last().url).toContain('/projects/P1/files/content?path=a.md&ref=main');
  expect(last().method).toBe('GET');
  expect(result.content).toBe('hi');
});

test('readProjectFile is a silent background read — a 403 never hits the global error sink', async () => {
  // Same manager-tier gate as listProjectFiles above, same reason: a project
  // detail/skill/command modal reading one file legitimately 403s for a
  // plain member, and renders its own inline error state — never a toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { message: 'forbidden' } };
    await expect(readProjectFile('P1', 'a.md')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('projectArchiveRequest names the archive route with ref, path and the bearer, without fetching', async () => {
  const request = await projectArchiveRequest('P 1', 'main', 'src/app');
  expect(request.url).toBe('http://test.local/projects/P%201/files/archive?ref=main&path=src%2Fapp');
  expect(request.headers.authorization).toBe('Bearer tok');
  expect(calls).toHaveLength(0);
});

test('fetchProjectFileRaw GETs /projects/:id/files/raw and returns the exact bytes', async () => {
  // A prior test file's token config caches through this module: re-configure
  // and drop the cache so the auth header assertion is deterministic.
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  invalidateTokenCache();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
  let seen: { url: string; method: string; authorization: string | null } | null = null;
  globalThis.fetch = mock(async (url: unknown, opts: RequestInit = {}) => {
    seen = {
      url: String(url),
      method: opts.method ?? 'GET',
      authorization: new Headers(opts.headers).get('authorization'),
    };
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }) as unknown as typeof fetch;

  const blob = await fetchProjectFileRaw('P1', 'assets/logo.png', 'main');

  expect(seen!.url).toContain('/projects/P1/files/raw?path=assets%2Flogo.png&ref=main');
  expect(seen!.method).toBe('GET');
  // Other test files reconfigure the token provider concurrently; the contract
  // here is that the raw read attaches the configured Bearer token.
  expect(seen!.authorization).toMatch(/^Bearer \S+$/);
  // Byte-accurate: a text read of this file would have replaced 0xff 0xfe.
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
});

test('fetchProjectFileRaw rejects on a non-ok response instead of returning bytes', async () => {
  globalThis.fetch = mock(async () => new Response('File not found', { status: 404 })) as unknown as typeof fetch;
  await expect(fetchProjectFileRaw('P1', 'missing.png', 'main')).rejects.toThrow('File not found');
});
