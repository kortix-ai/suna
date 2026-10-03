import { describe, expect, test } from 'bun:test';
import type { RecordedDriveMount } from './service';
import { isDriveSyncBox, syncMountAllows } from './sync';

const DRIVE = 'd1';
const me: RecordedDriveMount = { driveId: DRIVE, kind: 'personal', mountPath: '/drives/me', readOnly: true, role: 'me' };
const fromAgents: RecordedDriveMount = {
  driveId: DRIVE,
  kind: 'personal',
  mountPath: '/drives/from-agents',
  readOnly: false,
  role: 'me',
  subdir: '/From agents',
  fromAgents: true,
};

describe('drive sync authorization', () => {
  test('a read-only own drive with its writable From agents folder: read everywhere, write only in the folder', () => {
    const mounts = [me, fromAgents];
    expect(syncMountAllows(mounts, DRIVE, '/notes.md', 'read')).toBe(true);
    expect(syncMountAllows(mounts, DRIVE, '/notes.md', 'write')).toBe(false);
    expect(syncMountAllows(mounts, DRIVE, '/From agents/out.md', 'write')).toBe(true);
    // A sibling whose name only starts like the folder is outside it.
    expect(syncMountAllows(mounts, DRIVE, '/From agents2/out.md', 'write')).toBe(false);
  });

  test('a folder mount alone reads nothing outside its folder, and other drives read as missing', () => {
    expect(syncMountAllows([fromAgents], DRIVE, '/private.md', 'read')).toBe(false);
    expect(syncMountAllows([me, fromAgents], 'other', '/x', 'read')).toBe(false);
  });

  test('only a non-Platinum box marked at boot is a synced box', () => {
    expect(isDriveSyncBox({ provider: 'daytona', metadata: { driveSync: true } })).toBe(true);
    expect(isDriveSyncBox({ provider: 'daytona', metadata: {} })).toBe(false);
    expect(isDriveSyncBox({ provider: 'platinum', metadata: { driveSync: true } })).toBe(false);
  });
});
