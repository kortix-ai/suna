import { test, expect, beforeEach, mock } from 'bun:test';
import { configureKortix } from '../http/config';
import { setCurrentRuntime } from '../session/current-runtime';
import * as F from './client';
import { ApiError } from '../http/api/errors';
import { RuntimeNotReadyError } from '../runtime/client';

// Capture daemon requests by overriding ONLY the bottom-most seam
// (`globalThis.fetch`) instead of `mock.module('../http/auth', ...)` — the
// active-sandbox base URL ('http://sbx.test') is driven through the REAL
// `session/current-runtime` seam (`setCurrentRuntime`, in `beforeEach` below),
// and the token through the REAL `configureKortix` seam, so the REAL
// `authenticatedFetch` (auth header injection, timeout, retry) runs end to
// end. `mock.module('../http/auth', ...)` is process-wide and PERMANENT for
// the whole `bun test` sweep (see `server-store/active.test.ts`'s and
// `runtime/client.test.ts`'s own comments on this) — worse, `../http/auth` is
// a singleton module reached from many entry points (`runtime/client.ts`,
// hence `kortix.ts`), so whichever file's mock happens to be resident the
// FIRST time `runtime/client.ts` evaluates wins for every OTHER file that
// later shares that cached module instance too, including ones (like
// `kortix.test.ts`) that never opted into any mock at all. Driving
// `globalThis.fetch` avoids the collision entirely: it's reset in every
// test's own `beforeEach` (this file's and every other's), so there is
// nothing shared to collide with.
let calls: { url: string; method: string; body?: string; raw?: unknown }[] = [];
// When set, the mocked fetch responds with THIS status instead of a 200 —
// lets individual tests exercise the daemon-failure path.
let mockFailStatus: number | null = null;

const last = () => calls[calls.length - 1];
beforeEach(() => {
  calls = [];
  mockFailStatus = null;
  setCurrentRuntime('http://sbx.test', 'sbx-test');
  configureKortix({ backendUrl: 'http://sbx.test', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
      // Multipart bodies (FormData) are objects, not strings — keep the raw
      // value so the upload tests can assert the fields that were sent.
      raw: init.body,
    });
    if (mockFailStatus !== null) {
      return new Response(JSON.stringify({ error: 'daemon unavailable' }), {
        status: mockFailStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
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

// ── upload: timeouts are not transient ──────────────────────────────────────
//
// `Upload failed: signal timed out` on a real attachment. The network-throw
// path retried EVERYTHING, so a body large enough to blow the 30s deadline
// blew it on all three attempts and the user waited ~3x the timeout to be told
// it failed. A timeout is not transient the way a 503 is: re-sending the
// identical body against the identical budget cannot succeed.

/** What `AbortSignal.timeout()` throws — DOMException, name `TimeoutError`. */
function timeoutError(): Error {
  const err = new Error('signal timed out');
  err.name = 'TimeoutError';
  return err;
}

test('an upload that times out fails after ONE attempt, not three', async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts += 1;
    throw timeoutError();
  }) as unknown as typeof fetch;

  await expect(F.uploadFile(new Blob(['x']), '/workspace/uploads', 'a.zip')).rejects.toBeInstanceOf(
    ApiError,
  );
  expect(attempts).toBe(1);
});

test('an aborted upload is not retried either', async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts += 1;
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    throw err;
  }) as unknown as typeof fetch;

  await expect(F.uploadFile(new Blob(['x']), '/workspace/uploads', 'a.zip')).rejects.toThrow();
  expect(attempts).toBe(1);
});

test('a genuinely transient network throw is still retried', async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('fetch failed');
    return new Response(JSON.stringify([{ path: 'a.zip' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await F.uploadFile(new Blob(['x']), '/workspace/uploads', 'a.zip');
  expect(attempts).toBe(3);
});

test('a transient STATUS is still retried — the status path was already correct', async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts += 1;
    if (attempts < 2) {
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify([{ path: 'a.zip' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await F.uploadFile(new Blob(['x']), '/workspace/uploads', 'a.zip');
  expect(attempts).toBe(2);
});

// ── upload: the deadline scales with the body ───────────────────────────────

test('a large upload gets a longer deadline than the flat 30s default', async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  globalThis.fetch = mock(async (_input: unknown, init: RequestInit = {}) => {
    signals.push(init.signal);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  // 30 MB — comfortably past anything a flat 30s budget can move on a slow link.
  const big = new Blob([new Uint8Array(30 * 1024 * 1024)]);
  await F.uploadFile(big, '/workspace/uploads', 'big.zip');

  expect(signals).toHaveLength(1);
  expect(F.uploadTimeoutMsForBytes(big.size)).toBeGreaterThan(30_000);
});

test('the deadline is bounded at both ends', () => {
  // A tiny file must not get a shorter budget than the platform default...
  expect(F.uploadTimeoutMsForBytes(1)).toBeGreaterThanOrEqual(30_000);
  // ...and an enormous one must not wedge a handler forever.
  expect(F.uploadTimeoutMsForBytes(50 * 1024 * 1024 * 1024)).toBeLessThanOrEqual(15 * 60_000);
  // Monotonic in between.
  expect(F.uploadTimeoutMsForBytes(100 * 1024 * 1024)).toBeGreaterThan(
    F.uploadTimeoutMsForBytes(1024 * 1024),
  );
});

test('an unknown-size body still gets a usable deadline', () => {
  expect(F.uploadTimeoutMsForBytes(undefined)).toBeGreaterThanOrEqual(30_000);
});

// ── the runtime must be resolved before any byte leaves the client ───────────
//
// `getActiveOpenCodeUrl()` returns '' on a billing-enabled deployment until a
// session runtime is bound (see `session/server-store/active.ts`). Every op in
// this module used to interpolate that '' straight into `fetch()`, which makes
// the URL RELATIVE: the browser then POSTed the user's file AND their bearer
// token to the WEB origin (https://dev.kortix.com/file/upload), got the Next.js
// 404 HTML shell back, and showed "Upload failed (404): Not Found".
// The send path already refuses this (`runtime/client.ts` throws
// `RuntimeNotReadyError`); the files transport now refuses it identically.

/** Put the client in the exact state that produced '' — cloud deployment, no session bound. */
function withUnresolvedRuntime(): void {
  setCurrentRuntime(null);
  configureKortix({
    backendUrl: 'http://api.test',
    getToken: async () => 'tok',
    billingEnabled: true,
  });
}

const OPS: Array<[string, () => Promise<unknown>]> = [
  ['listFiles', () => F.listFiles('/workspace')],
  ['readFile', () => F.readFile('/workspace/a.txt')],
  ['readBlob', () => F.readBlob('/workspace/a.txt')],
  ['getFileStatus', () => F.getFileStatus()],
  ['findFiles', () => F.findFiles('a')],
  ['findText', () => F.findText('a')],
  ['uploadFile', () => F.uploadFile(new Blob(['x']), '/workspace', 'a.txt')],
  ['createFile', () => F.createFile('/workspace/a.txt')],
  ['copyFile', () => F.copyFile('/workspace/a.txt', '/workspace/b.txt')],
  ['writeFile', () => F.writeFile('/workspace/a.txt', new Blob(['x']))],
  ['deleteFile', () => F.deleteFile('/workspace/a.txt')],
  ['mkdir', () => F.mkdir('/workspace/d')],
  ['renameFile', () => F.renameFile('/workspace/a', '/workspace/b')],
];

test('every op refuses to run before the session runtime resolves — no relative-URL fetch', async () => {
  withUnresolvedRuntime();
  for (const [name, run] of OPS) {
    const error = await run().then(
      () => null,
      (err: unknown) => err,
    );
    expect(`${name}: ${(error as Error)?.name}`).toBe(`${name}: RuntimeNotReadyError`);
    expect(error).toBeInstanceOf(RuntimeNotReadyError);
  }
  // The decisive assertion: not one request went out on the wire.
  expect(calls).toEqual([]);
});

test('an explicitly empty baseUrl is refused too — it never falls back to the active sandbox', async () => {
  await expect(F.listFiles('/workspace', '')).rejects.toBeInstanceOf(RuntimeNotReadyError);
  await expect(F.uploadFile(new Blob(['x']), '/workspace', 'a.txt', '')).rejects.toBeInstanceOf(
    RuntimeNotReadyError,
  );
  await expect(F.writeFile('/workspace/a.txt', new Blob(['x']), '')).rejects.toBeInstanceOf(
    RuntimeNotReadyError,
  );
  expect(calls).toEqual([]);
});

// ── writeFile: overwrite-in-place, the primitive the daemon does not have ────
//
// The daemon writes with `flag: 'wx'` and, on EEXIST, lands the bytes under a
// SUFFIXED name (`notes-mdx8k2-3f9a1c04.md`). So "save this edited file" used to
// write a DIFFERENT file while the viewer re-read the original path and showed
// pre-edit bytes under a "File saved" toast. `writeFile` uploads to a temp name
// and renames over the target (`fs.rename` overwrites atomically), with a backup
// and rollback so a failed swap cannot destroy the original.

/** Route the daemon endpoints by URL + body, recording every call. */
function routeDaemon(handler: (url: string, init: RequestInit) => Response | undefined): void {
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
      raw: init.body,
    });
    return (
      handler(url, init) ??
      new Response(JSON.stringify(true), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as unknown as typeof fetch;
}

const jsonOk = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const renameBodies = () =>
  calls
    .filter((c) => c.url.endsWith('/file/rename'))
    .map((c) => JSON.parse(c.body!) as { from: string; to: string });

test('writeFile uploads to a temp name and renames it OVER the target path', async () => {
  routeDaemon((url) => {
    if (url.endsWith('/file/upload')) return jsonOk([{ path: '/workspace/.notes.md.tmp', size: 5 }]);
    return undefined;
  });

  const result = await F.writeFile('/workspace/notes.md', new Blob(['fresh']));

  expect(result).toEqual({ path: '/workspace/notes.md', bytes: 5 });
  // Parent dir ensured, then the upload, then the swap.
  expect(calls[0].url).toBe('http://sbx.test/file/mkdir');
  expect(JSON.parse(calls[0].body!)).toEqual({ path: '/workspace' });
  expect(calls[1].url).toBe('http://sbx.test/file/upload');

  const uploadForm = calls[1].raw as FormData;
  expect(uploadForm.get('path')).toBe('/workspace');
  // The temp name must not be the target name — that is the whole point.
  expect(String(uploadForm.get('filename'))).not.toBe('notes.md');
  expect(String(uploadForm.get('filename'))).toMatch(/^\.notes\.md\./);

  const renames = renameBodies();
  // 1) existing target → backup, 2) uploaded temp → the exact target path.
  expect(renames[0].from).toBe('/workspace/notes.md');
  expect(renames[0].to).toMatch(/^\/workspace\/notes\.md\./);
  expect(renames[1]).toEqual({ from: '/workspace/.notes.md.tmp', to: '/workspace/notes.md' });
  // The backup is cleaned up once the swap succeeded.
  const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => JSON.parse(c.body!).path);
  expect(deleted).toEqual([renames[0].to]);
});

test('writeFile renames the path the daemon ACTUALLY landed, not the one it asked for', async () => {
  // The daemon uniquifies on collision, so the returned path is authoritative.
  routeDaemon((url) => {
    if (url.endsWith('/file/upload')) return jsonOk([{ path: '.notes.md.tmp-3f9a1c04', size: 2 }]);
    return undefined;
  });

  await F.writeFile('/workspace/notes.md', new Blob(['hi']));

  const renames = renameBodies();
  expect(renames[1]).toEqual({
    from: '/workspace/.notes.md.tmp-3f9a1c04',
    to: '/workspace/notes.md',
  });
});

test('writeFile restores the backup and removes the temp when the swap fails', async () => {
  let renameCount = 0;
  routeDaemon((url) => {
    if (url.endsWith('/file/upload')) return jsonOk([{ path: '/workspace/.notes.md.tmp', size: 5 }]);
    if (url.endsWith('/file/rename')) {
      renameCount += 1;
      // 1st: target → backup (ok). 2nd: temp → target (fails). 3rd: restore (ok).
      if (renameCount === 2) {
        return new Response(JSON.stringify({ error: 'EPERM' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return undefined;
  });

  await expect(F.writeFile('/workspace/notes.md', new Blob(['fresh']))).rejects.toBeInstanceOf(
    ApiError,
  );

  const renames = renameBodies();
  expect(renames).toHaveLength(3);
  // The original file is put back exactly where it was.
  expect(renames[2]).toEqual({ from: renames[0].to, to: '/workspace/notes.md' });
  // ...and the orphaned temp upload is removed.
  const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => JSON.parse(c.body!).path);
  expect(deleted).toEqual(['/workspace/.notes.md.tmp']);
});

test('writeFile needs no backup when the target does not exist yet', async () => {
  routeDaemon((url, init) => {
    if (url.endsWith('/file/upload')) return jsonOk([{ path: '/workspace/.new.md.tmp', size: 1 }]);
    if (url.endsWith('/file/rename')) {
      const { from } = JSON.parse(String(init.body)) as { from: string };
      // Backing up a file that isn't there 404s; that is not an error.
      if (from === '/workspace/new.md') {
        return new Response(JSON.stringify({ error: 'ENOENT' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return undefined;
  });

  const result = await F.writeFile('/workspace/new.md', new Blob(['x']));

  expect(result.path).toBe('/workspace/new.md');
  expect(renameBodies()[1]).toEqual({ from: '/workspace/.new.md.tmp', to: '/workspace/new.md' });
  // Nothing was backed up, so nothing is deleted.
  expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
});

test('files namespace exposes write alongside upload', () => {
  expect(typeof F.files.write).toBe('function');
  expect(F.files.write).toBe(F.writeFile);
});

// ── copy goes through the SDK's own auth seam ────────────────────────────────
//
// `copyFile`'s upload called bare `fetch()` with a hand-rolled Authorization
// header, so it silently skipped `platformConfig().fetch` (mobile/whitelabel
// inject one), the size-scaled deadline, the 401 refresh-and-retry, and the
// X-Kortix-Client header.

test('copy uploads through platformConfig().fetch, not a bare global fetch', async () => {
  const seen: Array<{ url: string; clientHeader: string | null }> = [];
  const injected = mock(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, clientHeader: new Headers(init.headers).get('X-Kortix-Client') });
    if (url.includes('/file/raw')) {
      return new Response('bytes', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return jsonOk([{ path: '/workspace/b.txt', size: 5 }]);
  }) as unknown as typeof fetch;
  configureKortix({
    backendUrl: 'http://sbx.test',
    getToken: async () => 'tok',
    clientSource: 'web',
    fetch: injected,
  });

  await F.copyFile('/workspace/a.txt', '/workspace/b.txt');

  const upload = seen.find((s) => s.url.endsWith('/file/upload'));
  expect(upload).toBeDefined();
  expect(upload!.clientHeader).toBe('web');
  // The bare-fetch path would have gone to the global mock instead.
  expect(calls.filter((c) => c.url.endsWith('/file/upload'))).toEqual([]);
});

// ── the filename survives a zero-byte body ───────────────────────────────────
//
// Bun 1.3.14's multipart parser DROPS the `filename` of a zero-length part, so
// a genuinely empty upload reached the daemon with `file.name === undefined`
// and landed as a file literally named `undefined`. The workaround was to write
// a single space into every "new empty file" — which made every empty .json
// invalid and every new file 1 byte of 0x20. The name now travels as its own
// form field, so the body can be empty.

test('upload sends the filename as its own form field', async () => {
  await F.uploadFile(new Blob(['x']), '/workspace/uploads', 'shot.png');
  const form = last().raw as FormData;
  expect(form.get('filename')).toBe('shot.png');
  expect(form.get('path')).toBe('/workspace/uploads');
});

test('upload falls back to the File.name when no explicit filename is given', async () => {
  await F.uploadFile(new File(['x'], 'report.pdf'), '/workspace');
  expect((last().raw as FormData).get('filename')).toBe('report.pdf');
});

test('createFile writes a genuinely EMPTY file — no space byte', async () => {
  // NOTE: this used to assert `last()` was the upload itself, i.e. it pinned
  // the MECHANISM (one direct POST /file/upload). `createFile` now goes through
  // `writeFile` so it works on an un-upgraded daemon too (see the
  // mixed-version-fleet tests at the bottom of this file), so the mechanism is
  // upload-then-rename. The BEHAVIOUR under test is unchanged and still
  // asserted in full: 0 bytes, the name survives, the file lands at the
  // requested path.
  routeDaemon((url) => {
    if (url.endsWith('/file/upload')) {
      return jsonOk([{ path: '/workspace/.data.json.tmp', size: 0 }]);
    }
    return undefined;
  });

  const results = await F.createFile('/workspace/data.json');

  expect(results).toEqual([{ path: '/workspace/data.json', size: 0 }]);
  const form = calls.find((c) => c.url.endsWith('/file/upload'))!.raw as FormData;
  const part = form.get('file') as File;
  expect(part.size).toBe(0);
  expect(await part.text()).toBe('');
  // The name must survive the zero-byte body — as its own form field.
  expect(String(form.get('filename'))).toMatch(/^\.data\.json\./);
  expect(form.get('path')).toBe('/workspace');
});

// ── createFile across a MIXED-VERSION sandbox fleet ──────────────────────────
//
// The `filename` form field above is read by the daemon — and the daemon is
// BAKED INTO THE SANDBOX IMAGE (`/usr/local/bin/kortix-agent`,
// `apps/sandbox/Dockerfile`). `/v1/runtime-assets` reconciles only the CLI
// binary and the managed skills (`cli_sha256`, `managed_skills_hash`); it does
// NOT ship the daemon. So every sandbox provisioned before the image rebuild
// keeps its OLD daemon, while this SDK deploys with the web app immediately.
//
// On such a box a genuinely 0-byte part loses its filename in Bun's multipart
// parser, the old daemon never looks at the `filename` field, and a direct
// upload lands as a file literally named "undefined" — visibly, from the file
// explorer's "New File" button.
//
// `createFile` therefore goes through `writeFile`, which renames the path the
// daemon REPORTED onto the requested path. That makes it version-agnostic: on a
// new daemon the temp name lands and is renamed; on an old one "undefined"
// lands and is renamed. Either way the file ends up at the requested path with
// 0 bytes. Do not "simplify" this back into a direct upload.

test('createFile survives an OLD daemon that lands a zero-byte part as "undefined"', async () => {
  routeDaemon((url) => {
    // Exactly what a pre-rebuild kortix-agent returns for an empty part.
    if (url.endsWith('/file/upload')) return jsonOk([{ path: '/workspace/undefined', size: 0 }]);
    return undefined;
  });

  const results = await F.createFile('/workspace/notes.md');

  // The file exists at the path the user asked for, and it is genuinely empty.
  expect(results).toEqual([{ path: '/workspace/notes.md', size: 0 }]);
  const swap = renameBodies().at(-1);
  expect(swap).toEqual({ from: '/workspace/undefined', to: '/workspace/notes.md' });
  // And the bytes really were empty — no space hack anywhere on this path.
  const uploadForm = calls.find((c) => c.url.endsWith('/file/upload'))!.raw as FormData;
  expect((uploadForm.get('file') as File).size).toBe(0);
});

test('two concurrent createFile calls on an OLD daemon cannot cross', async () => {
  let uploads = 0;
  routeDaemon((url) => {
    if (url.endsWith('/file/upload')) {
      uploads += 1;
      // The daemon writes with O_EXCL and suffixes on EEXIST, so the second
      // "undefined" cannot clobber the first — it gets its own name back.
      return jsonOk([
        { path: uploads === 1 ? '/workspace/undefined' : '/workspace/undefined-4f2a1c', size: 0 },
      ]);
    }
    return undefined;
  });

  const [first, second] = await Promise.all([
    F.createFile('/workspace/a.md'),
    F.createFile('/workspace/b.md'),
  ]);

  expect(first).toEqual([{ path: '/workspace/a.md', size: 0 }]);
  expect(second).toEqual([{ path: '/workspace/b.md', size: 0 }]);
  // Each call renamed the path IT was told, so the two swaps are disjoint.
  const swaps = renameBodies()
    .filter((r) => r.from.startsWith('/workspace/undefined'))
    .sort((a, b) => a.to.localeCompare(b.to));
  expect(swaps).toHaveLength(2);
  expect(swaps[0].to).toBe('/workspace/a.md');
  expect(swaps[1].to).toBe('/workspace/b.md');
  expect(swaps[0].from).not.toBe(swaps[1].from);
  expect(new Set(swaps.map((s) => s.from))).toEqual(
    new Set(['/workspace/undefined', '/workspace/undefined-4f2a1c']),
  );
});

test('createFile keeps returning UploadResult[] — the published shape', async () => {
  routeDaemon((url) => {
    if (url.endsWith('/file/upload')) return jsonOk([{ path: '/workspace/.x.md.tmp', size: 0 }]);
    return undefined;
  });
  const results = await F.createFile('x.md');
  expect(Array.isArray(results)).toBe(true);
  expect(results[0]).toEqual({ path: '/workspace/x.md', size: 0 });
});

// REGRESSION (CodeQL js/polynomial-redos, HIGH). `writeFile` normalised its
// argument with `replace(/\/+$/, '')`. That pattern is UNANCHORED, so on a long
// run of slashes not at the end the engine retries it from every position —
// O(n^2). `filePath` comes from host UI input, so it is uncontrolled: a pasted
// path was enough to stall the tab. Replaced with an index walk.
test('a trailing-slash path with a pathological slash run normalises in linear time', async () => {
  routeDaemon((url) => {
    if (url.endsWith('/file/upload')) return jsonOk([{ path: '/workspace/dir/.tmp', size: 1 }]);
    return undefined;
  });

  // Behaviour first: trailing slashes are stripped, the rest is untouched.
  await F.writeFile('/workspace/dir/notes.md///', new Blob(['x']));
  const upload = calls.find((c) => c.url.includes('/file/upload'));
  const form = upload?.raw as FormData;
  expect(String(form.get('path'))).toBe('/workspace/dir');
  expect(String(form.get('filename'))).toContain('notes.md');

  // Then the property the regex broke. The pathological shape is a long run of
  // '/' with a non-slash AFTER it, so the old pattern backtracked over the whole
  // run at every offset. 200k chars finished in ~1s even then, so assert a bound
  // tight enough that a quadratic implementation cannot pass.
  const hostile = `/workspace/a${'/'.repeat(200_000)}b.txt`;
  const started = performance.now();
  await F.writeFile(hostile, new Blob(['x'])).catch(() => undefined);
  expect(performance.now() - started).toBeLessThan(1_000);
});

