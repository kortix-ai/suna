import { describe, expect, test } from 'bun:test';
import { pathCrumbs } from './viewer-actions';

describe('pathCrumbs — the folders the address pill shows', () => {
  test('drops the sandbox root and the file name', () => {
    expect(pathCrumbs('/workspace/src/pages/Home.tsx')).toEqual(['src', 'pages']);
  });

  test('a file at the root has no folders', () => {
    expect(pathCrumbs('/workspace/notes.txt')).toEqual([]);
  });

  test('a path outside /workspace keeps every folder', () => {
    expect(pathCrumbs('/tmp/out/report.pdf')).toEqual(['tmp', 'out']);
  });

  test('only a whole /workspace segment is the root', () => {
    expect(pathCrumbs('/workspaces/a/b.txt')).toEqual(['workspaces', 'a']);
  });

  test('no path, no folders', () => {
    expect(pathCrumbs(undefined)).toEqual([]);
    expect(pathCrumbs('')).toEqual([]);
  });
});
