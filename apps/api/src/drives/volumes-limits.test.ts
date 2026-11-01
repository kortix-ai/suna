// Platinum's limit refusals (#2422) reach the caller as typed refusals with
// their numbers, never as "storage unavailable": 413 file_too_large, 422
// sub_path_too_large (at a write and at a mount), 429 transfer_limit_exceeded
// (re-sent after Retry-After, then answered 429), 403 quota_exceeded.
import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';

type Scripted = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };
let script: Scripted[] = [];
let calls = 0;
mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  platinumFetch: async () => {
    calls++;
    const next = script.shift() ?? { status: 200, body: { path: '/Company/a.bin', size: 1 } };
    return Response.json(next.body, { status: next.status, headers: next.headers ?? {} });
  },
}));
const { DriveStorageError, writeVolumeFile, attachSandboxVolume } = await import('./volumes');
const VOLUME = { name: 'kd-synthetic', region: null, unfenced: true as const };
const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
afterEach(() => {
  calls = 0;
  script = [];
  sleep.mockClear();
});
afterAll(() => sleep.mockRestore());

const GIB = 1024 ** 3;
const write = () => writeVolumeFile(VOLUME, '/Company/a.bin', new Uint8Array(4), { overwrite: true }).catch((e: unknown) => e);

test('413 file_too_large ⇒ 413 with the limit and the numbers', async () => {
  script = [{ status: 413, body: { error: 'file too large', code: 'file_too_large', limit: 'file_bytes', max: 10 * GIB, requested: 12 * GIB } }];
  const err = (await write()) as InstanceType<typeof DriveStorageError>;
  expect(err).toBeInstanceOf(DriveStorageError);
  expect(err.status).toBe(413);
  expect(err.code).toBe('file_too_large');
  expect(err.detail).toEqual({ limit: 'file_bytes', max: 10 * GIB, requested: 12 * GIB });
  expect(err.message).toBe('This file is 12 GB. A file must be at most 10 GB.');
});

test('422 sub_path_too_large at a write ⇒ 422 naming the mounted folder, its size and the cap', async () => {
  script = [{
    status: 422,
    body: { error: 'folder /media is mounted by sub_path', code: 'sub_path_too_large', limit: 'sub_path_bytes', path: '/media', max: 10 * GIB, used: 9.9 * GIB, requested: 200 * 1024 * 1024 },
  }];
  const err = (await write()) as InstanceType<typeof DriveStorageError>;
  expect(err.status).toBe(422);
  expect(err.code).toBe('sub_path_too_large');
  expect(err.detail).toEqual({ limit: 'sub_path_bytes', path: '/media', max: 10 * GIB, used: 9.9 * GIB, requested: 200 * 1024 * 1024 });
  expect(err.message).toBe(
    'The folder /media is mounted in sessions, and a folder a session mounts can hold at most 10 GB. It holds 9.9 GB, and this adds 200 MB. Put the file in another folder, or move large files out of this one.',
  );
});

test('422 sub_path_too_large at a mount keeps its code (the session records the folder too large)', async () => {
  script = [{ status: 422, body: { error: 'the subdir is larger than a sub_path mount allows', code: 'sub_path_too_large', bytes: 12 * GIB, max_bytes: 10 * GIB } }];
  const err = (await attachSandboxVolume('sbx', '/drives/company', { volume: VOLUME, readOnly: false, subdir: '/Company' }).catch((e: unknown) => e)) as InstanceType<typeof DriveStorageError>;
  expect(err.code).toBe('sub_path_too_large');
  expect(err.detail).toEqual({ limit: 'sub_path_bytes', max: 10 * GIB, used: 12 * GIB });
});

test('429 transfer_limit_exceeded is re-sent after Retry-After and lands', async () => {
  const busy = { status: 429, body: { error: 'busy', code: 'transfer_limit_exceeded', limit: 'transfer_bytes' }, headers: { 'retry-after': '1' } };
  script = [busy, busy, { status: 200, body: { path: '/Company/a.bin', size: 4 } }];
  const written = await writeVolumeFile(VOLUME, '/Company/a.bin', new Uint8Array(4), { overwrite: true });
  expect(written.size).toBe(4);
  expect(calls).toBe(3);
  expect(sleep).toHaveBeenCalledWith(1_000);
});

test('429 that persists ⇒ 429 with Retry-After, never "storage unavailable"', async () => {
  const busy = { status: 429, body: { error: 'busy', code: 'transfer_limit_exceeded', limit: 'transfer_bytes', scope: 'volume' }, headers: { 'retry-after': '2' } };
  script = [busy, busy, busy, busy];
  const err = (await write()) as InstanceType<typeof DriveStorageError>;
  expect(calls).toBe(4);
  expect(err.status).toBe(429);
  expect(err.code).toBe('transfer_limit_exceeded');
  expect(err.retryAfterSeconds).toBe(2);
  expect(err.message).not.toMatch(/unavailable/i);
});

test('403 quota_exceeded on the volume size ⇒ 403 storage_limit_exceeded with the numbers', async () => {
  script = [{ status: 403, body: { error: 'volume full', code: 'quota_exceeded', limit: 'bytes', max: 100 * GIB, used: 99 * GIB, requested: 2 * GIB } }];
  const err = (await write()) as InstanceType<typeof DriveStorageError>;
  expect(err.status).toBe(403);
  expect(err.code).toBe('storage_limit_exceeded');
  expect(err.detail).toEqual({ limit: 'volume_bytes', max: 100 * GIB, used: 99 * GIB, requested: 2 * GIB });
  expect(err.message).toBe("This project's Files are full: 99 GB of 100 GB used. Delete files you no longer need, then try again.");
});

test('403 quota_exceeded without numbers (an older Platinum) still answers 403, never 503', async () => {
  script = [{ status: 403, body: { error: 'quota exceeded', code: 'quota_exceeded' } }];
  const err = (await write()) as InstanceType<typeof DriveStorageError>;
  expect(err.status).toBe(403);
  expect(err.code).toBe('storage_limit_exceeded');
  expect(err.message).toBe("This project's Files are full. Delete files you no longer need, then try again.");
});
