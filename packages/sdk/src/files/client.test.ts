import { test, expect, beforeEach, mock } from 'bun:test';
import * as realServerStore from '../state/server-store';
import * as realAuth from '../platform/auth';

// Capture daemon requests by overriding ONLY the two seams the file client uses
// (spread the real module so every other importer's exports stay intact).
let calls: { url: string; method: string; body?: string }[] = [];
// When set, the mocked `authenticatedFetch` responds with THIS status instead
// of a 200 — lets individual tests exercise the daemon-failure path.
let mockFailStatus: number | null = null;

mock.module('../state/server-store', () => ({
  ...realServerStore,
  getActiveOpenCodeUrl: () => 'http://sbx.test',
}));
mock.module('../platform/auth', () => ({
  ...realAuth,
  getAuthToken: async () => 'tok',
  authenticatedFetch: async (url: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined });
    if (mockFailStatus !== null) {
      return new Response(JSON.stringify({ error: 'daemon unavailable' }), {
        status: mockFailStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  },
}));

const F = await import('./client');
const { ApiError } = await import('../platform/api/errors');
const last = () => calls[calls.length - 1];
beforeEach(() => {
  calls = [];
  mockFailStatus = null;
});

test('list hits GET /file with worktree-relative path', async () => {
  await F.listFiles('/workspace/src');
  expect(last().url).toBe('http://sbx.test/file?path=src');
  expect(last().method).toBe('GET');
});

test('read hits GET /file/content', async () => {
  await F.readFile('/workspace/a.txt').catch(() => {});
  expect(last().url).toBe('http://sbx.test/file/content?path=a.txt');
});

test('list of a non-workspace sandbox root keeps the absolute path', async () => {
  await F.listFiles('/tmp');
  expect(last().url).toBe(`http://sbx.test/file?path=${encodeURIComponent('/tmp')}`);
});

test('read of a /tmp file passes the absolute path through to the daemon', async () => {
  await F.readFile('/tmp/gmail_invite_list.png').catch(() => {});
  expect(last().url).toBe(
    `http://sbx.test/file/content?path=${encodeURIComponent('/tmp/gmail_invite_list.png')}`,
  );
});

test('readBlob of a /home file hits /file/raw with the absolute path', async () => {
  await F.readBlob('/home/user/report.pdf').catch(() => {});
  expect(calls[0].url).toBe(
    `http://sbx.test/file/raw?path=${encodeURIComponent('/home/user/report.pdf')}`,
  );
});

test('toDaemonPath maps workspace to relative and other sandbox roots to absolute', () => {
  expect(F.toDaemonPath('/workspace')).toBe('');
  expect(F.toDaemonPath('/workspace/')).toBe('');
  expect(F.toDaemonPath('/workspace/a.txt')).toBe('a.txt');
  expect(F.toDaemonPath('/tmp/shot.png')).toBe('/tmp/shot.png');
  expect(F.toDaemonPath('/tmp')).toBe('/tmp');
  expect(F.toDaemonPath('/home/user/x')).toBe('/home/user/x');
  expect(F.toDaemonPath('/opt/tool/bin')).toBe('/opt/tool/bin');
  expect(F.toDaemonPath('/tmpfile.txt')).toBe('tmpfile.txt');
  expect(F.toDaemonPath('/etc/passwd')).toBe('etc/passwd');
  expect(F.toDaemonPath('/README.md')).toBe('README.md');
  expect(F.toDaemonPath('src/a.ts')).toBe('src/a.ts');
  expect(F.toDaemonPath('')).toBe('');
});

test('toSandboxAbsolutePath keeps allowed roots and anchors the rest under /workspace', () => {
  expect(F.toSandboxAbsolutePath('/tmp/a.png')).toBe('/tmp/a.png');
  expect(F.toSandboxAbsolutePath('/home/u/a.png')).toBe('/home/u/a.png');
  expect(F.toSandboxAbsolutePath('/opt/a.png')).toBe('/opt/a.png');
  expect(F.toSandboxAbsolutePath('/workspace/a.png')).toBe('/workspace/a.png');
  expect(F.toSandboxAbsolutePath('a/b.png')).toBe('/workspace/a/b.png');
  expect(F.toSandboxAbsolutePath('/foo/b.png')).toBe('/workspace/foo/b.png');
  expect(F.toSandboxAbsolutePath('/tmpfoo/b.png')).toBe('/workspace/tmpfoo/b.png');
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

// ── typed errors (P0 fix: every op used to throw a bare `Error`; now every
// HTTP failure throws `ApiError` with status/response attached) ─────────────

test('findFiles throws ApiError on a daemon failure — no longer swallows to []', async () => {
  mockFailStatus = 500;
  await expect(F.findFiles('foo')).rejects.toBeInstanceOf(ApiError);
  await expect(F.findFiles('foo')).rejects.toMatchObject({ status: 500 });
});

test('listFiles throws ApiError (with status) on a daemon failure', async () => {
  mockFailStatus = 503;
  await expect(F.listFiles('/workspace')).rejects.toBeInstanceOf(ApiError);
  await expect(F.listFiles('/workspace')).rejects.toMatchObject({ status: 503 });
});

test('deleteFile/mkdir/renameFile throw ApiError (with status) on a daemon failure', async () => {
  mockFailStatus = 404;
  await expect(F.deleteFile('/workspace/x')).rejects.toBeInstanceOf(ApiError);
  await expect(F.mkdir('/workspace/y')).rejects.toBeInstanceOf(ApiError);
  await expect(F.renameFile('/workspace/a', '/workspace/b')).rejects.toBeInstanceOf(ApiError);
});

// ── explicit baseUrl param (internal plumbing for `kortix.session(pid, sid).files`)

test('every op accepts an explicit trailing baseUrl, overriding the module-global active sandbox', async () => {
  mockFailStatus = null;
  await F.listFiles('/workspace/src', 'http://other-sandbox.test');
  expect(last().url).toBe('http://other-sandbox.test/file?path=src');

  await F.getFileStatus('http://other-sandbox.test');
  expect(last().url).toBe('http://other-sandbox.test/file/status');

  await F.findFiles('foo', undefined, 'http://other-sandbox.test');
  expect(last().url).toContain('http://other-sandbox.test/find/file?query=foo');
});
