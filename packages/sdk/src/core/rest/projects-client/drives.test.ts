import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  deleteDriveFile,
  downloadDriveFile,
  getFolderAccess,
  listAgentMounts,
  getDriveFileUrl,
  listDriveFiles,
  listDriveVersions,
  listSessionDrives,
  makeDriveFolder,
  moveDriveFile,
  restoreDriveVersion,
  unshareFolder,
  uploadDriveFile,
} from './drives';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let next: { status: number; body: BodyInit | null; type: string } = { status: 200, body: '{}', type: 'application/json' };

function respond(status: number, body: unknown) {
  next = { status, body: JSON.stringify(body), type: 'application/json' };
}

beforeEach(() => {
  calls = [];
  respond(200, {});
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input instanceof Request ? input.url : input), method: init.method ?? 'GET', headers, body: init.body });
    return new Response(next.status === 204 ? null : next.body, { status: next.status, headers: { 'content-type': next.type } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;
const D = '11111111-2222-4333-8444-555555555555';

test('file operations encode the path in the query', async () => {
  respond(200, { entries: [{ path: '/a b', name: 'a b', type: 'dir', size: 0, mtime: 1 }] });
  const entries = await listDriveFiles(D, '/a b');
  expect(last().url).toBe(`http://test.local/drives/${D}/files?path=%2Fa+b`);
  expect(entries[0]!.type).toBe('dir');

  respond(200, { path: '/a b/x.txt', size: 3 });
  await uploadDriveFile(D, '/a b/x.txt', new Blob(['abc']));
  expect(last().method).toBe('PUT');
  expect(last().url).toBe(`http://test.local/drives/${D}/files/content?path=%2Fa+b%2Fx.txt`);
  expect(last().headers['content-type']).toBe('application/octet-stream');

  respond(200, { path: '/n' });
  await makeDriveFolder(D, '/n');
  expect(JSON.parse(String(last().body))).toEqual({ path: '/n' });

  respond(200, { from: '/n', to: '/m' });
  await moveDriveFile(D, '/n', '/m');
  expect(JSON.parse(String(last().body))).toEqual({ from: '/n', to: '/m' });

  next = { status: 204, body: null, type: '' };
  await deleteDriveFile(D, '/m', { recursive: true });
  expect([last().method, last().url]).toEqual(['DELETE', `http://test.local/drives/${D}/files?path=%2Fm&recursive=true`]);
});

test('downloadDriveFile returns the bytes with the caller token and throws ApiError on failure', async () => {
  next = { status: 200, body: 'hello', type: 'application/octet-stream' };
  const blob = await downloadDriveFile(D, '/x.txt');
  expect(await blob.text()).toBe('hello');
  expect(last().url).toBe(`http://test.local/drives/${D}/files/content?path=%2Fx.txt`);
  expect(last().headers.authorization).toBe('Bearer tok');

  respond(404, { error: true, message: 'File or folder not found' });
  const err = await downloadDriveFile(D, '/gone').catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(404);
});

test('getDriveFileUrl trims the backend URL in linear time (CodeQL js/polynomial-redos)', () => {
  // `/\/+$/` backtracks quadratically on a slash run that does not end the
  // string: seconds at 100k slashes, well under 1 ms linear.
  const backendUrl = `http://test.local${'/'.repeat(100_000)}x`;
  configureKortix({ backendUrl, getToken: async () => 'tok' });
  try {
    const started = performance.now();
    expect(getDriveFileUrl(D, '/r.pdf')).toBe(`${backendUrl}/drives/${D}/files/content?path=%2Fr.pdf`);
    expect(performance.now() - started).toBeLessThan(500);
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('getDriveFileUrl builds the content URL, with download when asked', () => {
  expect(getDriveFileUrl(D, '/r.pdf')).toBe(`http://test.local/drives/${D}/files/content?path=%2Fr.pdf`);
  expect(getDriveFileUrl(D, '/r.pdf', { download: true })).toBe(
    `http://test.local/drives/${D}/files/content?path=%2Fr.pdf&download=1`,
  );
});

test('versions, restore and session drives', async () => {
  respond(200, { versions: [{ id: 'c1', createdAt: 't', kind: 'edit', author: 'drive', changes: { changed: 1, deleted: 0 } }] });
  expect((await listDriveVersions(D))[0]!.id).toBe('c1');
  expect(last().url).toBe(`http://test.local/drives/${D}/versions`);

  next = { status: 204, body: null, type: '' };
  await restoreDriveVersion(D, 'c1');
  expect([last().method, last().url]).toEqual(['POST', `http://test.local/drives/${D}/restore`]);
  expect(JSON.parse(String(last().body))).toEqual({ versionId: 'c1' });

  respond(200, { drives: [{ driveId: D, name: 'Users / ana', kind: 'project', mountPath: '/drives/me', readOnly: false, subdir: '/Users/ana', role: 'me' }] });
  const mounted = await listSessionDrives('p1', 's1');
  expect(last().url).toBe('http://test.local/projects/p1/sessions/s1/drives');
  expect(mounted[0]!.mountPath).toBe('/drives/me');
});

test('stopping a share reports the sessions it has not reached yet', async () => {
  next = { status: 204, body: null, type: '' };
  expect(await unshareFolder(D, 'g1')).toEqual({ pendingSessions: 0 });
  expect(last().method).toBe('DELETE');
  expect(last().url).toBe(`http://test.local/drives/${D}/access/g1`);

  respond(202, { pendingSessions: 2 });
  expect(await unshareFolder(D, 'g1')).toEqual({ pendingSessions: 2 });
});

test("an agent's mounts are the folders a new session of it mounts", async () => {
  respond(200, {
    mounts: [{ path: '/Company', mountPath: '/drives/Company', readOnly: false, via: 'project', level: 'write' }],
    skipped: [],
    slots: 8,
  });
  const plan = await listAgentMounts(D, 'research bot');
  expect(last().method).toBe('GET');
  expect(last().url).toBe(`http://test.local/drives/${D}/agents/research%20bot/mounts`);
  expect(plan.mounts[0]!.mountPath).toBe('/drives/Company');
  expect(plan.slots).toBe(8);
});

// ── Upload progress over XHR ──
// `fetch` reports no upload progress, so `onProgress` sends the body with
// XMLHttpRequest instead, under the same auth and headers.
type FakeXhr = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  upload: { onprogress: ((e: { loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  status: number;
  responseText: string;
};
function installXhr(answer: (xhr: FakeXhr) => void): FakeXhr[] {
  const sent: FakeXhr[] = [];
  class Xhr implements FakeXhr {
    method = '';
    url = '';
    headers: Record<string, string> = {};
    body: unknown = null;
    upload = { onprogress: null as ((e: { loaded: number }) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    }
    send(body: unknown) {
      this.body = body;
      sent.push(this);
      queueMicrotask(() => answer(this));
    }
    abort() {
      this.onabort?.();
    }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = Xhr;
  return sent;
}

test('onProgress uploads over XHR, reports bytes sent, and resolves the server answer', async () => {
  const sent = installXhr((xhr) => {
    xhr.upload.onprogress?.({ loaded: 4 });
    xhr.upload.onprogress?.({ loaded: 10 });
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ path: '/a/x.bin', size: 10 });
    xhr.onload?.();
  });
  const progress: Array<[number, number]> = [];
  try {
    const result = await uploadDriveFile(D, '/a/x.bin', new Blob(['0123456789']), {
      ifMatch: 'v1',
      onProgress: (sentBytes, total) => progress.push([sentBytes, total]),
    });
    expect(result).toEqual({ path: '/a/x.bin', size: 10 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('PUT');
    expect(sent[0]!.url).toBe(`http://test.local/drives/${D}/files/content?path=%2Fa%2Fx.bin`);
    expect(sent[0]!.headers.authorization).toBe('Bearer tok');
    expect(sent[0]!.headers['content-type']).toBe('application/octet-stream');
    expect(sent[0]!.headers['if-match']).toBe('v1');
    expect(progress).toEqual([
      [4, 10],
      [10, 10],
    ]);
    // Nothing went through fetch.
    expect(calls).toHaveLength(0);
  } finally {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  }
});

test('an XHR upload the server refuses throws an ApiError with its status and message', async () => {
  installXhr((xhr) => {
    xhr.status = 409;
    xhr.responseText = JSON.stringify({ message: 'file changed', code: 'file_changed' });
    xhr.onload?.();
  });
  try {
    const error = await uploadDriveFile(D, '/x', new Blob(['a']), { onProgress: () => undefined }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe('file changed');
  } finally {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  }
});

test('without XMLHttpRequest, onProgress falls back to fetch and reports completion', async () => {
  respond(200, { path: '/x', size: 1 });
  const progress: Array<[number, number]> = [];
  await uploadDriveFile(D, '/x', new Blob(['a']), { onProgress: (s, t) => progress.push([s, t]) });
  expect(last().method).toBe('PUT');
  expect(progress).toEqual([[1, 1]]);
});

// A folder listing is rendered by its caller (an error state, or a step up to
// the parent when the folder is gone), so a failed one raises no app-wide
// error. A new folder's card listed it before the server had made it, and the
// 404 surfaced as a "File or folder not found" toast.
test('a failed folder listing does not reach the app-wide error handler', async () => {
  const seen: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError: (e) => void seen.push(e) });
  try {
    respond(404, { message: 'File or folder not found' });
    const error = await listDriveFiles(D, '/new').catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
    expect(seen).toHaveLength(0);
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError: undefined });
  }
});

test('a refused folder write or sharing read leaves the error to the caller: no app-wide onError', async () => {
  const reported: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError: (e) => void reported.push(e) });
  try {
    respond(400, { error: true, message: 'This folder cannot be moved or renamed' });
    const moved = await moveDriveFile(D, '/Users', '/People').catch((e) => e);
    expect((moved as ApiError).message).toBe('This folder cannot be moved or renamed');
    await makeDriveFolder(D, '/Users/x').catch(() => undefined);
    await deleteDriveFile(D, '/Company').catch(() => undefined);
    respond(403, { error: true, message: 'You cannot open this folder' });
    await getFolderAccess(D, '/a').catch(() => undefined);
    expect(reported).toEqual([]);
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError: undefined });
  }
});
