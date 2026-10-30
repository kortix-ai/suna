import { describe, expect, test } from 'bun:test';

import {
  type DirectoryLoaders,
  type DriveMount,
  type DriveReads,
  blobToReadResult,
  drivesMountPath,
  mountChildren,
  resolveMountedPath,
  withDriveMounts,
} from './drive-mounts.ts';
import { toViewerState } from './file-viewer.tsx';

const MOUNTS: DriveMount[] = [
  { driveId: 'drv-1', mountPath: '/drives/me', subdir: '/Users/ana' },
  { driveId: 'drv-1', mountPath: '/drives/Company/Reports', subdir: '/Company/Reports' },
  { driveId: 'drv-1', mountPath: '/drives/all', subdir: '/' },
];

interface Calls {
  sandboxList: string[];
  sandboxRead: string[];
  driveList: Array<[string, string]>;
  driveRead: Array<[string, string]>;
}

function setup() {
  const calls: Calls = { sandboxList: [], sandboxRead: [], driveList: [], driveRead: [] };
  const sandbox: DirectoryLoaders = {
    listDirectory: async (path) => {
      calls.sandboxList.push(path);
      return [{ name: 'README.md', path: '/workspace/README.md', type: 'file', ignored: false }];
    },
    readFile: async (path) => {
      calls.sandboxRead.push(path);
      return { type: 'text', content: 'sandbox' };
    },
  };
  const drive: DriveReads = {
    listFolder: async (driveId, path) => {
      calls.driveList.push([driveId, path]);
      if (path === '/Users/ana') {
        return {
          entries: [
            { path: '/Users/ana/notes.md', name: 'notes.md', type: 'file' },
            { path: '/Users/ana/Memory', name: 'Memory', type: 'dir' },
            { path: '/Users/ana/link', name: 'link', type: 'symlink' },
          ],
        };
      }
      if (path === '/') return { entries: [{ path: '/Company', name: 'Company', type: 'dir' }] };
      return { entries: [] };
    },
    readFile: async (driveId, path) => {
      calls.driveRead.push([driveId, path]);
      return new Blob(['# Notes\n']);
    },
  };
  return { calls, loaders: withDriveMounts(sandbox, MOUNTS, drive, '/workspace') };
}

describe('drivesMountPath / resolveMountedPath', () => {
  test('absolute and agent-relative /drives paths resolve; others and dot segments do not', () => {
    expect(drivesMountPath('/drives/me/a.md')).toBe('/drives/me/a.md');
    expect(drivesMountPath('drives/me/a.md')).toBe('/drives/me/a.md');
    expect(drivesMountPath('/workspace/drives/me')).toBeNull();
    expect(drivesMountPath('/drives/me/../../etc')).toBeNull();
  });

  test('the longest mount wins and the rest maps under its folder', () => {
    expect(resolveMountedPath('/drives/me/Memory/x.md', MOUNTS)).toMatchObject({
      driveId: 'drv-1',
      path: '/Users/ana/Memory/x.md',
    });
    expect(resolveMountedPath('/drives/Company/Reports/q3.md', MOUNTS)?.path).toBe(
      '/Company/Reports/q3.md',
    );
    // A mount of the whole drive (`subdir: '/'`) maps its root to `/`.
    expect(resolveMountedPath('/drives/all', MOUNTS)?.path).toBe('/');
    expect(resolveMountedPath('/drives/Company', MOUNTS)).toBeNull();
  });

  test('mountChildren synthesizes the folders on the way to a deep mount', () => {
    expect(mountChildren('/drives', MOUNTS).map((node) => node.path)).toEqual([
      '/drives/me',
      '/drives/Company',
      '/drives/all',
    ]);
    expect(mountChildren('/drives/Company', MOUNTS).map((node) => node.path)).toEqual([
      '/drives/Company/Reports',
    ]);
  });
});

describe('withDriveMounts', () => {
  test('the workspace root gains one /drives folder; other sandbox paths are untouched', async () => {
    const { calls, loaders } = setup();
    const root = await loaders.listDirectory('/workspace');
    expect(root.map((node) => node.path)).toEqual(['/workspace/README.md', '/drives']);
    const sub = await loaders.listDirectory('/workspace/src');
    expect(sub.map((node) => node.path)).toEqual(['/workspace/README.md']);
    expect(calls.sandboxList).toEqual(['/workspace', '/workspace/src']);
  });

  test('a mount lists its Drive folder under mount paths, without the sandbox', async () => {
    const { calls, loaders } = setup();
    const nodes = await loaders.listDirectory('/drives/me');
    expect(nodes.map((node) => [node.path, node.type])).toEqual([
      ['/drives/me/notes.md', 'file'],
      ['/drives/me/Memory', 'directory'],
    ]);
    expect(calls.driveList).toEqual([['drv-1', '/Users/ana']]);
    expect(calls.sandboxList).toEqual([]);

    const whole = await loaders.listDirectory('/drives/all');
    expect(whole.map((node) => node.path)).toEqual(['/drives/all/Company']);
  });

  test('/drives and a folder above a deep mount list the synthetic folders', async () => {
    const { calls, loaders } = setup();
    expect((await loaders.listDirectory('/drives')).map((node) => node.name)).toEqual([
      'me',
      'Company',
      'all',
    ]);
    expect((await loaders.listDirectory('/drives/Company')).map((node) => node.name)).toEqual([
      'Reports',
    ]);
    expect(calls.driveList).toEqual([]);
  });

  test('a file under a mount reads through Drive; outside every mount it throws', async () => {
    const { calls, loaders } = setup();
    const result = await loaders.readFile('/drives/me/notes.md');
    expect(result).toEqual({ type: 'text', content: '# Notes\n' });
    expect(calls.driveRead).toEqual([['drv-1', '/Users/ana/notes.md']]);
    expect(calls.sandboxRead).toEqual([]);
    await expect(loaders.readFile('/drives/other/x.md')).rejects.toThrow('not under a mounted Drive folder');
    expect(await loaders.readFile('/workspace/README.md')).toEqual({ type: 'text', content: 'sandbox' });
  });

  test('no mounts: the sandbox loaders come back unchanged', () => {
    const sandbox: DirectoryLoaders = {
      listDirectory: async () => [],
      readFile: async () => ({}),
    };
    const drive: DriveReads = {
      listFolder: async () => ({ entries: [] }),
      readFile: async () => new Blob([]),
    };
    expect(withDriveMounts(sandbox, [], drive, '/workspace')).toBe(sandbox);
  });
});

describe('blobToReadResult', () => {
  test('UTF-8 is text; other bytes are base64 the viewer sizes', async () => {
    expect(await blobToReadResult(new Blob(['héllo']))).toEqual({ type: 'text', content: 'héllo' });
    const binary = await blobToReadResult(new Blob([new Uint8Array([0xff, 0xfe, 0x00, 0x01])]));
    expect(binary).toMatchObject({ type: 'binary', encoding: 'base64', content: '//4AAQ==' });
    expect(toViewerState('/drives/me/x.bin', binary)).toMatchObject({ kind: 'binary', bytes: 4 });
  });
});
