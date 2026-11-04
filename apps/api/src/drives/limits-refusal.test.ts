// A single write larger than the whole limit is refused before storage is
// asked for a fresh figure, and the refusal still names what the project
// holds: "uses 0 bytes" was false for a project that held data (dev,
// 2026-11-02: a 6 GiB plan on a project holding 1 MiB answered `used: 0`).
import { expect, mock, test } from 'bun:test';

const HELD = 1_093_632;
mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  platinumFetch: async (path: string) => {
    if (path.startsWith('/v1/volumes/limits')) return Response.json({ max_bytes_per_volume: 100 * 1024 ** 3, subdir_max_bytes: 10 * 1024 ** 3, max_mounts_per_sandbox: 8 });
    if (path.startsWith('/v1/volumes/kd-')) return Response.json({ id: 'v', logical_bytes: HELD, file_count: 7, usage: { logical_bytes: HELD, file_count: 7 } });
    return Response.json({});
  },
}));
mock.module('../billing/services/billing-cache', () => ({
  resolveAccountBilling: async () => ({ source: 'account', features: { key: 'free' }, limitOverrides: { driveProjectBytes: 5 * 1024 ** 3 } }),
}));

const { config } = await import('../config');
(config as { KORTIX_BILLING_INTERNAL_ENABLED: boolean }).KORTIX_BILLING_INTERNAL_ENABLED = true;
const { assertDriveWriteFits, forgetDriveUsage } = await import('./limits');
const { DriveStorageError } = await import('./volumes');

test('an upload larger than the whole project limit is refused with what the project really holds', async () => {
  const drive = { accountId: 'acc', platinumVolumeName: 'kd-refusal-test-0001', platinumVolumeRegion: null, platinumVolumeId: null };
  forgetDriveUsage(drive.platinumVolumeName);
  const err = await assertDriveWriteFits(drive, { bytes: 6 * 1024 ** 3 }).catch((e) => e);
  expect(err).toBeInstanceOf(DriveStorageError);
  expect(err).toMatchObject({ code: 'storage_limit_exceeded' });
  expect((err as { detail?: { used?: number } }).detail?.used).toBe(HELD);
});
