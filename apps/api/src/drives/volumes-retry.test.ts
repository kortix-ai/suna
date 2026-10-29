import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';

let statuses: number[] = [];
let calls = 0;
mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumFetch: async () => {
    calls++;
    return Response.json({ id: 'synthetic-volume', code: 'storage_unavailable' }, { status: statuses.shift() ?? 200 });
  },
}));
const { getDriveVolume, deleteDriveVolume, DriveStorageError } = await import('./volumes');
const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
afterEach(() => { calls = 0; statuses = []; sleep.mockClear(); });
afterAll(() => sleep.mockRestore());

test('a volume read recovers from two transient storage 503s', async () => {
  statuses = [503, 503, 200];
  const result = await getDriveVolume('synthetic-volume');
  expect(result.id).toBe('synthetic-volume');
  expect(calls).toBe(3);
});

test('persistent storage failure remains a typed error after bounded retries', async () => {
  statuses = [503, 503, 503];
  const result = getDriveVolume('synthetic-volume').catch((error: unknown) => error);
  expect(await result).toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(3);
});

test('writes and non-transient read errors are never retried', async () => {
  statuses = [503];
  await expect(deleteDriveVolume('synthetic-volume')).rejects.toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(1);
  statuses = [404];
  await expect(getDriveVolume('synthetic-volume')).rejects.toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(2);
});

test('an aborted read does not retry an upstream 503', async () => {
  statuses = [503];
  const controller = new AbortController();
  const result = getDriveVolume('synthetic-volume', controller.signal).catch((error: unknown) => error);
  controller.abort();
  expect(await result).toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(1);
});

test('cancellation during backoff stops the next storage request', async () => {
  statuses = [503, 200];
  const controller = new AbortController();
  sleep.mockImplementationOnce(async () => { controller.abort(); });
  await expect(getDriveVolume('synthetic-volume', controller.signal)).rejects.toBeInstanceOf(DriveStorageError);
  expect(calls).toBe(1);
});
