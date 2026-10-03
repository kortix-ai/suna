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

describe('drive sync conditional write', () => {
  test('two writers based on the same version: under the path lock only the first writes', async () => {
    const { syncVersionToken, withSyncPathLock } = await import('./sync');
    let file: { size: number; mtime: number } | null = { size: 4, mtime: 100 };
    const base = syncVersionToken(file);
    const writes: string[] = [];
    // check, then a storage round-trip, then write: the window the lock closes.
    const conditional = (who: string) =>
      withSyncPathLock(DRIVE, '/a.md', async () => {
        if (syncVersionToken(file) !== base) return 'conflict';
        await new Promise((r) => setTimeout(r, 20));
        file = { size: 9, mtime: 200 + writes.length };
        writes.push(who);
        return 'written';
      });
    const results = await Promise.all([conditional('box-1'), conditional('box-2')]);
    expect(results).toEqual(['written', 'conflict']);
    expect(writes).toEqual(['box-1']);
    expect(syncVersionToken(null)).toBe('absent');
  });

  test('a failed write releases the lock for the next writer', async () => {
    const { withSyncPathLock } = await import('./sync');
    await expect(withSyncPathLock(DRIVE, '/b.md', async () => { throw new Error('storage down'); })).rejects.toThrow('storage down');
    expect(await withSyncPathLock(DRIVE, '/b.md', async () => 'ok')).toBe('ok');
  });
});
