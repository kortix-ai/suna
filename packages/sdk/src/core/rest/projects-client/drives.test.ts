import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  deleteDriveFile,
  downloadDriveFile,
  getFolderAccess,
  listAgentMounts,
  listProjectMounts,
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

const realFetch = globalThis.fetch;
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

test('the project mounts are the folders every session mounts', async () => {
  respond(200, { mounts: [], skipped: [], slots: 8 });
  await listProjectMounts(D);
  expect(last().url).toBe(`http://test.local/drives/${D}/mounts`);
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

// Above the API's 64 MiB single-PUT cap, a file goes up in 1 MiB blocks:
// plan (every block's sha256), only the blocks the store lacks, commit.
const MiB = 1024 * 1024;
const hex = async (b: Blob) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A 64 MiB + 1.5 MiB file: 66 blocks, the last one half a block. */
function bigFile(): Blob {
  const bytes = new Uint8Array(64 * MiB + 1.5 * MiB);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251;
  return new Blob([bytes]);
}

type BlockServer = { calls: Call[]; plan?: { path: string; size: number; blocks: string[] }; failBlock?: (n: number) => number | null };
function installBlockServer(missing: (blocks: string[]) => string[], server: BlockServer = { calls: [] }): BlockServer {
  let blockCalls = 0;
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    server.calls.push({ url, method: init.method ?? 'GET', headers, body: init.body });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/files/upload')) {
      server.plan = JSON.parse(String(init.body));
      return json(200, { uploadId: 'up.1', missing: missing(server.plan!.blocks), expiresAt: '2030-01-01T00:00:00Z' });
    }
    if (url.includes('/blocks/')) {
      const fail = server.failBlock?.(blockCalls++);
      if (fail) return json(fail, { error: true, message: 'block refused' });
      const sha = url.split('/blocks/')[1]!;
      if ((await hex(new Blob([init.body as Uint8Array<ArrayBuffer>]))) !== sha) return json(400, { error: true, message: 'sha mismatch' });
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/commit')) return json(200, { path: server.plan!.path, size: server.plan!.size });
    return json(404, { error: true, message: 'no route' });
  }) as unknown as typeof fetch;
  return server;
}

test('a file above 64 MiB goes up in 1 MiB blocks: plan, only the missing blocks, commit', async () => {
  const file = bigFile();
  // The store already holds every second block.
  const server = installBlockServer((blocks) => blocks.filter((_, i) => i % 2 === 0));
  const progress: number[] = [];
  const result = await uploadDriveFile(D, '/a/big.bin', file, { ifMatch: '"v1"', onProgress: (sent, total) => {
    expect(total).toBe(file.size);
    progress.push(sent);
  } });

  expect(result).toEqual({ path: '/a/big.bin', size: file.size });
  const [plan, ...rest] = server.calls;
  expect([plan!.method, plan!.url]).toEqual(['POST', `http://test.local/drives/${D}/files/upload`]);
  expect(plan!.headers['if-match']).toBe('"v1"');
  expect(server.plan!.path).toBe('/a/big.bin');
  expect(server.plan!.size).toBe(file.size);
  expect(server.plan!.blocks).toHaveLength(66);
  expect(server.plan!.blocks[65]).toBe(await hex(file.slice(65 * MiB)));
  const blocks = rest.filter((c) => c.url.includes('/blocks/'));
  expect(blocks).toHaveLength(33);
  expect(blocks.every((c) => c.method === 'PUT' && c.url.startsWith(`http://test.local/drives/${D}/files/upload/up.1/blocks/`))).toBe(true);
  expect(new Set(blocks.map((c) => c.url)).size).toBe(33);
  const commit = server.calls[server.calls.length - 1]!;
  expect([commit.method, commit.url]).toEqual(['POST', `http://test.local/drives/${D}/files/upload/up.1/commit`]);
  expect(progress[progress.length - 1]).toBe(file.size);
  expect([...progress].sort((a, b) => a - b)).toEqual(progress);
});

test('the same input as bytes takes the block path too; at most 4 blocks are in flight', async () => {
  const bytes = new Uint8Array(await bigFile().arrayBuffer());
  let inFlight = 0;
  let peak = 0;
  const server = installBlockServer((blocks) => blocks);
  const answer = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    try {
      return await answer(input as Request, init);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  await uploadDriveFile(D, '/a/big.bin', bytes);
  expect(server.calls.filter((c) => c.url.includes('/blocks/'))).toHaveLength(66);
  expect(peak).toBeLessThanOrEqual(4);
});

test('a block that fails with 503 is sent again; a refused block (403) is not', async () => {
  // ponytail: real 0.5 s backoff; bun's fake timers also freeze the test's own timeout.
  const flaky = installBlockServer((blocks) => blocks.slice(0, 2), { calls: [], failBlock: (n) => (n === 0 ? 503 : null) });
  await uploadDriveFile(D, '/a/big.bin', bigFile());
  expect(flaky.calls.filter((c) => c.url.includes('/blocks/'))).toHaveLength(3);
  expect(flaky.calls.some((c) => c.url.endsWith('/commit'))).toBe(true);

  const refused = installBlockServer((blocks) => blocks.slice(0, 1), { calls: [], failBlock: () => 403 });
  const error = await uploadDriveFile(D, '/a/big.bin', bigFile()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(403);
  expect(refused.calls.filter((c) => c.url.includes('/blocks/'))).toHaveLength(1);
  expect(refused.calls.some((c) => c.url.endsWith('/commit'))).toBe(false);
});

test('an aborted block upload stops and throws an ABORTED ApiError', async () => {
  const controller = new AbortController();
  const server = installBlockServer((blocks) => {
    controller.abort();
    return blocks;
  });
  const error = await uploadDriveFile(D, '/a/big.bin', bigFile(), { signal: controller.signal }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe('ABORTED');
  expect(server.calls.filter((c) => c.url.includes('/blocks/')).length).toBe(0);
  expect(server.calls.some((c) => c.url.endsWith('/commit'))).toBe(false);
});

// Bun cannot send a slice of a file-backed Blob as a fetch body (the socket
// closes): every block goes up as bytes. Over a real socket, from a real file.
test('a file-backed Blob above 64 MiB uploads over a real socket', async () => {
  const { openAsBlob } = await import('node:fs');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'sdk-drive-upload-'));
  const received = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      if (url.pathname.endsWith('/files/upload')) {
        const plan = JSON.parse(new TextDecoder().decode(body)) as { blocks: string[] };
        return Response.json({ uploadId: 'up.1', missing: plan.blocks, expiresAt: null });
      }
      if (url.pathname.includes('/blocks/')) {
        const sha = url.pathname.split('/blocks/')[1]!;
        if ((await hex(new Blob([body]))) !== sha) return Response.json({ message: 'sha mismatch' }, { status: 400 });
        received.set(sha, body.byteLength);
        return new Response(null, { status: 204 });
      }
      return Response.json({ path: '/a/big.bin', size: 1 });
    },
  });
  try {
    globalThis.fetch = realFetch;
    configureKortix({ backendUrl: server.url.origin, getToken: async () => 'tok' });
    await writeFile(join(dir, 'big.bin'), new Uint8Array(await bigFile().arrayBuffer()));
    await uploadDriveFile(D, '/a/big.bin', await openAsBlob(join(dir, 'big.bin')));
    expect([...received.values()].reduce((a, b) => a + b, 0)).toBe(64 * MiB + 1.5 * MiB);
  } finally {
    server.stop(true);
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
    await rm(dir, { recursive: true, force: true });
  }
});
