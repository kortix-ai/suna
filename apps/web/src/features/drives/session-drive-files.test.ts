/**
 * A session file under a drive mount is read through the drive API. The box
 * daemon serves only /workspace, so `/drives/me/cat.gif` answered 403 and the
 * relative `drives/me/cat.gif` 404: the chat card said "Preview unavailable"
 * for a file the Files page previews fine.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

const DRIVE = 'drive-me';
const driveReads: Array<{ driveId: string; path: string }> = [];
const sandboxReads: string[] = [];
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff, 0xfe]);

const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...realSdk,
  readDriveFile: async (driveId: string, path: string) => {
    driveReads.push({ driveId, path });
    return { blob: new Blob([GIF], { type: 'application/octet-stream' }), version: '"v1"' };
  },
  readBlob: async (path: string) => {
    sandboxReads.push(path);
    return new Blob(['sandbox']);
  },
  readFile: async (path: string) => {
    sandboxReads.push(path);
    return { type: 'text', content: 'sandbox' };
  },
}));

const { qk } = await import('@kortix/sdk/react');
const { resolveSessionDriveFile, setSessionDriveFilesScope } = await import('./session-drive-files');
const { readFile, readFileAsBlob } = await import('@/features/files/api/runtime-files');

const mounts = [
  { driveId: DRIVE, mountPath: '/drives/me', subdir: '/Users/ana' },
  { driveId: 'company', mountPath: '/drives/company', subdir: '/' },
];

let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  driveReads.length = 0;
  sandboxReads.length = 0;
});

function openSession() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(qk.drives.session('p1', 's1'), { drives: mounts, personal: true });
  undo = setSessionDriveFilesScope({ projectId: 'p1', sessionId: 's1', queryClient });
}

describe('session drive files', () => {
  test('a mount path maps to its drive and folder', () => {
    expect(resolveSessionDriveFile('/drives/me/dancing.gif', mounts)).toEqual({
      driveId: DRIVE,
      path: '/Users/ana/dancing.gif',
    });
    expect(resolveSessionDriveFile('drives/me/a/b.xlsx', mounts)).toEqual({ driveId: DRIVE, path: '/Users/ana/a/b.xlsx' });
    expect(resolveSessionDriveFile('/drives/company/report.pdf', mounts)).toEqual({ driveId: 'company', path: '/report.pdf' });
    expect(resolveSessionDriveFile('/drives/me/../../etc/passwd', mounts)).toBeNull();
    expect(resolveSessionDriveFile('/drives/meow/a.gif', mounts)).toBeNull();
    expect(resolveSessionDriveFile('/workspace/drives/me/a.gif', mounts)).toBeNull();
  });

  test('the viewer reads a drive file from the drive, everything else from the box', async () => {
    openSession();
    const blob = await readFileAsBlob('/drives/me/dancing.gif');
    expect(blob.type).toBe('image/gif');
    const content = await readFile('drives/me/dancing.gif');
    expect(content).toMatchObject({ type: 'binary', encoding: 'base64', mimeType: 'image/gif' });
    expect(driveReads).toEqual([
      { driveId: DRIVE, path: '/Users/ana/dancing.gif' },
      { driveId: DRIVE, path: '/Users/ana/dancing.gif' },
    ]);

    await readFileAsBlob('/workspace/report.md');
    await readFile('/drives/unmounted/a.txt');
    expect(sandboxReads).toEqual(['/workspace/report.md', '/drives/unmounted/a.txt']);
    expect(driveReads).toHaveLength(2);
  });
});
