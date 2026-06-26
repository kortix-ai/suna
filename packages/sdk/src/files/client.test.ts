import { test, expect, beforeEach, mock } from 'bun:test';
import * as realServerStore from '../state/server-store';
import * as realAuth from '../platform/auth';

// Capture daemon requests by overriding ONLY the two seams the file client uses
// (spread the real module so every other importer's exports stay intact).
let calls: { url: string; method: string; body?: string }[] = [];

mock.module('../state/server-store', () => ({
  ...realServerStore,
  getActiveOpenCodeUrl: () => 'http://sbx.test',
}));
mock.module('../platform/auth', () => ({
  ...realAuth,
  getAuthToken: async () => 'tok',
  authenticatedFetch: async (url: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  },
}));

const F = await import('./client');
const last = () => calls[calls.length - 1];
beforeEach(() => { calls = []; });

test('list hits GET /file with worktree-relative path', async () => {
  await F.listFiles('/workspace/src');
  expect(last().url).toBe('http://sbx.test/file?path=src');
  expect(last().method).toBe('GET');
});

test('read hits GET /file/content', async () => {
  await F.readFile('/workspace/a.txt').catch(() => {});
  expect(last().url).toBe('http://sbx.test/file/content?path=a.txt');
});

test('status hits GET /file/status', async () => {
  await F.getFileStatus();
  expect(last().url).toBe('http://sbx.test/file/status');
});

test('findFiles hits GET /find/file', async () => {
  await F.findFiles('foo');
  expect(last().url).toContain('/find/file?query=foo');
});

test('mkdir POSTs to /file/mkdir with path body', async () => {
  await F.mkdir('/workspace/newdir');
  expect(last().url).toBe('http://sbx.test/file/mkdir');
  expect(last().method).toBe('POST');
  expect(JSON.parse(last().body!)).toEqual({ path: '/workspace/newdir' });
});

test('delete DELETEs /file with path body', async () => {
  await F.deleteFile('/workspace/x');
  expect(last().url).toBe('http://sbx.test/file');
  expect(last().method).toBe('DELETE');
  expect(JSON.parse(last().body!)).toEqual({ path: '/workspace/x' });
});

test('rename POSTs to /file/rename with from/to', async () => {
  await F.renameFile('/workspace/a', '/workspace/b');
  expect(last().url).toBe('http://sbx.test/file/rename');
  expect(JSON.parse(last().body!)).toEqual({ from: '/workspace/a', to: '/workspace/b' });
});

test('files namespace exposes the full surface', () => {
  for (const k of ['list','read','readBlob','status','findFiles','findText','upload','create','copy','remove','mkdir','rename','currentProject','health','isReachable']) {
    expect(typeof (F.files as Record<string, unknown>)[k]).toBe('function');
  }
});
