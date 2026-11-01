// The Files limits as one decision: the plan's figures or the override, never
// above what Platinum can hold. Pure (combineDriveLimits); the refusal names
// its limit and numbers.
import { expect, mock, test } from 'bun:test';

mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  platinumFetch: async () => Response.json({}),
}));
const { combineDriveLimits, storageLimitRefusal, fileLimitRefusal, DEFAULT_FOLDER_MOUNT_BYTES } = await import('./limits');

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
