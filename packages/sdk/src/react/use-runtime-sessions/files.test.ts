import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { FileNode } from '../../core/files/types';

let findFilesImpl: (
  query: string,
  options?: { type?: 'file' | 'directory'; limit?: number },
) => Promise<string[]>;
let listFilesImpl: (path: string) => Promise<FileNode[]>;

import { findRuntimeFiles } from './files';

const realDateNow = Date.now;
let fakeNow = realDateNow();
Date.now = () => fakeNow;

beforeEach(() => {
  // Expire the module-level index cache so every test controls both the
  // direct daemon query and the fallback index independently.
  fakeNow += 61_000;
  findFilesImpl = async () => [];
  listFilesImpl = async () => [];
});

afterAll(() => {
  Date.now = realDateNow;
});

describe('findRuntimeFiles', () => {
  test('ranks exact basename, prefix, basename substring, then path substring', async () => {
    findFilesImpl = async (query) =>
      query
        ? [
            'src/components/app.tsx',
            'src/app-config.ts',
            'app',
            'app-folder/utils.ts',
          ]
        : [];

    expect(await findRuntimeFiles('app', { findFiles: findFilesImpl, listFiles: listFilesImpl })).toEqual([
      'app',
      'src/app-config.ts',
      'src/components/app.tsx',
      'app-folder/utils.ts',
    ]);
  });

  test('deduplicates direct and fallback-index results', async () => {
    findFilesImpl = async (query) =>
      query ? ['src/app.ts'] : ['src/app.ts', 'src/app-utils.ts'];

    expect(await findRuntimeFiles('app', { findFiles: findFilesImpl, listFiles: listFilesImpl })).toEqual([
      'src/app-utils.ts',
      'src/app.ts',
    ]);
  });

  test('an empty query ranks shallower paths first', async () => {
    findFilesImpl = async () => ['a/b/c/deep.ts', 'top.ts', 'a/mid.ts'];

    expect(await findRuntimeFiles('', { findFiles: findFilesImpl, listFiles: listFilesImpl })).toEqual([
      'top.ts',
      'a/mid.ts',
      'a/b/c/deep.ts',
    ]);
  });

  test('caps results at 20 entries', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      `file${String(index).padStart(2, '0')}.ts`,
    );
    findFilesImpl = async () => many;

    expect(await findRuntimeFiles('file', { findFiles: findFilesImpl, listFiles: listFilesImpl })).toHaveLength(20);
  });

  test('treats a rejecting daemon search as no matches', async () => {
    findFilesImpl = async () => {
      throw new Error('network down');
    };

    await expect(
      findRuntimeFiles('anything', { findFiles: findFilesImpl, listFiles: listFilesImpl }),
    ).resolves.toEqual([]);
  });

  test('falls back to the neutral workspace listing when the daemon index is empty', async () => {
    findFilesImpl = async () => [];
    listFilesImpl = async (path) => {
      expect(path).toBe('/workspace');
      return [
        {
          name: 'app.ts',
          path: '/workspace/src/app.ts',
          absolute: '/workspace/src/app.ts',
          type: 'file',
          ignored: false,
        },
        {
          name: 'src',
          path: '/workspace/src',
          absolute: '/workspace/src',
          type: 'directory',
          ignored: false,
        },
      ];
    };

    expect(await findRuntimeFiles('app', { findFiles: findFilesImpl, listFiles: listFilesImpl })).toEqual([
      '/workspace/src/app.ts',
    ]);
  });
});
