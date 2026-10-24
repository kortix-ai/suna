import { expect, mock, test } from 'bun:test';

let status = 416;
let receivedRange: string | null = null;
mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumFetch: async (_path: string, init: RequestInit) => {
    receivedRange = new Headers(init.headers).get('range');
    return new Response(null, { status, headers: { 'content-range': 'bytes */10' } });
  },
}));

const { readVolumeFile, getDriveVolume, DriveStorageError } = await import('./volumes');

test('an unsatisfiable download range preserves 416 and the file size instead of reporting a storage outage', async () => {
  status = 416;
  const response = await readVolumeFile('synthetic-volume', '/Company/ten.txt', 'bytes=10-');
  expect(receivedRange).toBe('bytes=10-');
  expect(response.status).toBe(416);
  expect(response.headers.get('content-range')).toBe('bytes */10');
});

test('full and partial downloads retain their status; real storage failures still reject', async () => {
  for (const expected of [200, 206]) {
    status = expected;
    const response = await readVolumeFile('synthetic-volume', '/Company/ten.txt');
    expect(response.status).toBe(expected);
    expect(receivedRange).toBeNull();
  }
  status = 500;
  await expect(readVolumeFile('synthetic-volume', '/Company/ten.txt')).rejects.toBeInstanceOf(DriveStorageError);
  status = 416;
  await expect(getDriveVolume('synthetic-volume')).rejects.toBeInstanceOf(DriveStorageError);
});
