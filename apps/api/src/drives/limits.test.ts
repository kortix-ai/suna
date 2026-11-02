// The Files limits as one decision: the plan's figures or the override, never
// above what Platinum can hold. Pure (combineDriveLimits); the refusal names
// its limit and numbers.
import { expect, mock, test } from 'bun:test';

let volumeReads = 0;
let usedNow = 0;
mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  platinumFetch: async (path: string) => {
    if (path.startsWith('/v1/volumes/kd-')) {
      volumeReads++;
      await Bun.sleep(5);
      return Response.json({ id: 'v', logical_bytes: usedNow, file_count: 1, head_commit_id: 'c1', usage: { logical_bytes: usedNow, file_count: 1 }, folders: [{ path: '/Company', bytes: 7, commit_id: 'c1' }] });
    }
    return Response.json({});
  },
}));
const {
  combineDriveLimits,
  storageLimitRefusal,
  fileLimitRefusal,
  DEFAULT_FOLDER_MOUNT_BYTES,
  driveWriteRefusal,
  driveVolumeUsage,
  forgetDriveUsage,
  driveFolderSizes,
} = await import('./limits');

const GIB = 1024 ** 3;
const platinum = { max_bytes_per_volume: 100 * GIB, subdir_max_bytes: 10 * GIB, max_mounts_per_sandbox: 8 };
const plan = { projectBytes: 5 * GIB, accountBytes: 5 * GIB };

test('the plan decides; a file is capped at the folder-mount cap', () => {
  expect(combineDriveLimits({ plan, overrides: {}, platinum, mountsPerSession: 8 })).toEqual({
    projectBytes: 5 * GIB,
    accountBytes: 5 * GIB,
    fileBytes: 10 * GIB,
    requestBytes: 64 * 1024 * 1024,
    folderMountBytes: 10 * GIB,
    mountsPerSession: 8,
    source: 'plan',
  });
  const large = combineDriveLimits({ plan: { projectBytes: 50 * GIB, accountBytes: 250 * GIB }, overrides: {}, platinum, mountsPerSession: 8 });
  expect(large.fileBytes).toBe(10 * GIB);
});

test('an override replaces the plan figure, and never exceeds the volume size', () => {
  const small = combineDriveLimits({ plan, overrides: { driveProjectBytes: 1024, driveAccountBytes: 4096 }, platinum, mountsPerSession: 8 });
  expect(small).toMatchObject({ projectBytes: 1024, accountBytes: 4096, fileBytes: 10 * GIB, source: 'override' });
  const huge = combineDriveLimits({ plan, overrides: { driveProjectBytes: 500 * GIB }, platinum, mountsPerSession: 8 });
  expect(huge.projectBytes).toBe(100 * GIB);
});

test('billing off: no plan, so Platinum alone limits the project and nothing limits the account', () => {
  expect(combineDriveLimits({ plan: null, overrides: {}, platinum, mountsPerSession: 8 })).toMatchObject({
    projectBytes: 100 * GIB,
    accountBytes: null,
    source: 'platinum',
  });
});

test('Platinum limits that cannot be read: the 10 GiB folder cap, no volume clamp', () => {
  const blind = combineDriveLimits({ plan, overrides: {}, platinum: {}, mountsPerSession: 8 });
  expect(blind.folderMountBytes).toBe(DEFAULT_FOLDER_MOUNT_BYTES);
  expect(blind.projectBytes).toBe(5 * GIB);
  // #2422 publishes the cap as sub_path_max_bytes; it wins over the older name.
  expect(combineDriveLimits({ plan, overrides: {}, platinum: { sub_path_max_bytes: 2 * GIB, subdir_max_bytes: 10 * GIB }, mountsPerSession: 8 }).folderMountBytes).toBe(2 * GIB);
});

test('a refusal names the limit and its numbers, in a sentence a person can act on', () => {
  const project = storageLimitRefusal({ limit: 'project_bytes', max: 5 * GIB, used: 4.8 * GIB, requested: 300 * 1024 * 1024 });
  expect(project.status).toBe(403);
  expect(project.code).toBe('storage_limit_exceeded');
  expect(project.detail).toEqual({ limit: 'project_bytes', max: 5 * GIB, used: 4.8 * GIB, requested: 300 * 1024 * 1024 });
  expect(project.message).toBe(
    "This project's Files use 4.8 GB of 5 GB. This upload needs 300 MB; 205 MB is left. Delete files you no longer need, or ask an account admin about a plan with more storage.",
  );
  const account = storageLimitRefusal({ limit: 'account_bytes', max: 5 * GIB, used: 5 * GIB, requested: 1024 });
  expect(account.message).toBe(
    "Your account's Files, across all its projects, use 5 GB of 5 GB. This upload needs 1 KB; no space is left. Delete files in any of its projects, or ask an account admin about a plan with more storage.",
  );
  const file = fileLimitRefusal(10 * GIB, 12 * GIB);
  expect([file.status, file.code, file.detail]).toEqual([413, 'file_too_large', { limit: 'file_bytes', max: 10 * GIB, requested: 12 * GIB }]);
  expect(file.message).toBe('This file is 12 GB. A file in Files can be at most 10 GB, the largest folder a session can mount.');
  expect(fileLimitRefusal(10 * GIB, 10 * GIB + 1).message).toMatch(/^This file is larger than 10 GB\./);
});

const limits5 = combineDriveLimits({ plan, overrides: {}, platinum, mountsPerSession: 8 });

test('a plan is judged by its total: ten 4 GiB files never pass a 5 GiB project limit', () => {
  const sizes = Array.from({ length: 10 }, () => 4 * GIB);
  // Each file alone would fit an empty project; the commit lands all ten.
  expect(driveWriteRefusal({ limits: limits5, sizes: [4 * GIB], projectUsed: 0, accountUsed: 0, credit: 0 })).toBeNull();
  const refusal = driveWriteRefusal({ limits: limits5, sizes, projectUsed: 0, accountUsed: 0, credit: 0 });
  expect(refusal?.code).toBe('storage_limit_exceeded');
  expect(refusal?.detail).toEqual({ limit: 'project_bytes', max: 5 * GIB, used: 0, requested: 40 * GIB });
});

test('the account total is judged too, with the overwrite credit; a file over the cap is refused first', () => {
  const tight = { ...limits5, projectBytes: 100 * GIB, accountBytes: 5 * GIB };
  expect(driveWriteRefusal({ limits: tight, sizes: [GIB, GIB], projectUsed: 0, accountUsed: 4 * GIB, credit: 0 })?.detail?.limit).toBe('account_bytes');
  expect(driveWriteRefusal({ limits: tight, sizes: [GIB, GIB], projectUsed: 0, accountUsed: 4 * GIB, credit: GIB })).toBeNull();
  expect(driveWriteRefusal({ limits: limits5, sizes: [11 * GIB], projectUsed: 0, accountUsed: 0, credit: 0 })?.code).toBe('file_too_large');
});

test('a size that is not a whole number of bytes is refused, never skipped', () => {
  for (const bad of [Number.NaN, -1, 1.5]) {
    const refusal = driveWriteRefusal({ limits: limits5, sizes: [1, bad], projectUsed: 0, accountUsed: 0, credit: 0 });
    expect(refusal?.status).toBe(400);
    expect(refusal?.code).toBe('invalid_size');
  }
});

const drive = { platinumVolumeName: 'kd-cache-test', platinumVolumeRegion: null, platinumVolumeId: 'vol_1' };

test('usage reads are cached, shared while in flight, and a write decision reads fresh', async () => {
  volumeReads = 0;
  usedNow = 100;
  forgetDriveUsage(drive.platinumVolumeName);
  const [a, b, c] = await Promise.all([driveVolumeUsage(drive), driveVolumeUsage(drive), driveVolumeUsage(drive)]);
  expect(volumeReads).toBe(1);
  expect([a?.usedBytes, b?.usedBytes, c?.usedBytes]).toEqual([100, 100, 100]);
  usedNow = 200;
  expect((await driveVolumeUsage(drive))?.usedBytes).toBe(100);
  expect(volumeReads).toBe(1);
  expect((await driveVolumeUsage(drive, { fresh: true }))?.usedBytes).toBe(200);
  expect(volumeReads).toBe(2);
});

test("folder sizes come from the volume's own measured folders, with no listing", async () => {
  volumeReads = 0;
  forgetDriveUsage(drive.platinumVolumeName);
  const sizes = await driveFolderSizes(drive, ['/Company']);
  expect(sizes.get('/Company')).toEqual({ path: '/Company', bytes: 7, complete: true });
  expect(volumeReads).toBe(1);
});

test('a drive whose row has no volume id is read by its volume name: 182 of 359 prod drives have none', async () => {
  usedNow = 4096;
  const unrecorded = { ...drive, platinumVolumeId: null, platinumVolumeName: 'kd-no-stored-id-00001' };
  forgetDriveUsage(unrecorded.platinumVolumeName);
  expect((await driveVolumeUsage(unrecorded, { fresh: true }))?.usedBytes).toBe(4096);
});
