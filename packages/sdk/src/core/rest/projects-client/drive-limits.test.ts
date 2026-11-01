// Files limits on the public surface: what a project's Files and an account's
// Files hold against their limits, and every refusal of a limit readable as
// one typed value (code, limit, max, used, requested), whichever transport
// the request took (fetch or the XHR upload with progress).
import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import { DRIVE_LIMIT_CODES, driveLimitRefusal, getAccountStorageUsage, getDriveUsage, uploadDriveFile } from './drives';

type Call = { url: string; method: string };
let calls: Call[] = [];
let next: { status: number; body: string } = { status: 200, body: '{}' };
const respond = (status: number, body: unknown) => (next = { status, body: JSON.stringify(body) });

beforeEach(() => {
  calls = [];
  respond(200, {});
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), method: init.method ?? 'GET' });
    return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const D = '11111111-2222-4333-8444-555555555555';
const A = '99999999-2222-4333-8444-555555555555';
const GIB = 1024 ** 3;

const usage = {
  driveId: D,
  projectId: 'p1',
  usedBytes: 4 * GIB,
  fileCount: 12,
  limits: { projectBytes: 5 * GIB, accountBytes: 5 * GIB, fileBytes: 10 * GIB, requestBytes: 64 * 1024 * 1024, folderMountBytes: 10 * GIB, mountsPerSession: 8 },
  account: { usedBytes: 4.5 * GIB, limitBytes: 5 * GIB, complete: true },
  folders: [{ path: '/Company', bytes: 9 * GIB, files: 3, complete: true, state: 'near_limit' }],
};

test('getDriveUsage reads the project Files usage and limits', async () => {
  respond(200, usage);
  const u = await getDriveUsage(D);
  expect(calls.at(-1)).toEqual({ url: `http://test.local/drives/${D}/usage`, method: 'GET' });
  expect(u.limits.projectBytes).toBe(5 * GIB);
  expect(u.folders[0]!.state).toBe('near_limit');
});

test("getAccountStorageUsage reads the account's Files per project, scoped by account_id", async () => {
  respond(200, { accountId: A, usedBytes: 1, complete: true, limits: usage.limits, projects: [{ projectId: 'p1', name: 'One', driveId: D, usedBytes: 1, fileCount: 1 }] });
  const a = await getAccountStorageUsage(A);
  expect(calls.at(-1)).toEqual({ url: `http://test.local/drives/usage?account_id=${A}`, method: 'GET' });
  expect(a.projects[0]!.name).toBe('One');
});

test('a storage refusal from fetch reads as a typed limit refusal with its numbers', async () => {
  respond(403, { error: true, message: 'full', code: 'storage_limit_exceeded', limit: 'project_bytes', max: 1024, used: 10, requested: 2048 });
  const err = await uploadDriveFile(D, '/Company/a.txt', new Blob(['x'])).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(driveLimitRefusal(err)).toEqual({ code: 'storage_limit_exceeded', status: 403, limit: 'project_bytes', max: 1024, used: 10, requested: 2048, message: 'full' });
});

test('the XHR upload keeps the refusal body, so the same refusal reads the same', async () => {
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = class {
    upload = { onprogress: null };
    onload: (() => void) | null = null;
    onerror = null;
    onabort = null;
    status = 0;
    responseText = '';
    open() {}
    setRequestHeader() {}
    send() {
      queueMicrotask(() => {
        this.status = 422;
        this.responseText = JSON.stringify({ message: 'folder full', code: 'sub_path_too_large', limit: 'sub_path_bytes', path: '/media', max: 10, used: 9, requested: 2 });
        this.onload?.();
      });
    }
    abort() {}
  };
  try {
    const err = await uploadDriveFile(D, '/media/a', new Blob(['ab']), { onProgress: () => undefined }).catch((e: unknown) => e);
    expect(driveLimitRefusal(err)).toEqual({ code: 'sub_path_too_large', status: 422, limit: 'sub_path_bytes', path: '/media', max: 10, used: 9, requested: 2, message: 'folder full' });
  } finally {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  }
});

test('every limit code reads; any other error is not a limit refusal', async () => {
  expect([...DRIVE_LIMIT_CODES].sort() as string[]).toEqual(
    ['file_too_large', 'payload_too_large', 'quota_exceeded', 'storage_limit_exceeded', 'sub_path_too_large', 'transfer_limit_exceeded'].sort(),
  );
  expect(driveLimitRefusal(new ApiError('x', { status: 409, code: 'file_changed' }))).toBeNull();
  expect(driveLimitRefusal(new Error('x'))).toBeNull();
  expect(driveLimitRefusal(null)).toBeNull();
  // An older API: the code alone, no numbers.
  expect(driveLimitRefusal(new ApiError('too large', { status: 413, code: 'file_too_large' }))).toEqual({ code: 'file_too_large', status: 413, message: 'too large' });
});
