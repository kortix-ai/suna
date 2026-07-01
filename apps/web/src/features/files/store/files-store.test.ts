import { expect, test } from 'bun:test';

import { createFilesStore, isWithinRoot } from './files-store';

test('isWithinRoot matches the root itself and descendants only', () => {
  expect(isWithinRoot('/workspace', '/workspace')).toBe(true);
  expect(isWithinRoot('/workspace/', '/workspace')).toBe(true);
  expect(isWithinRoot('/workspace/src/a.ts', '/workspace')).toBe(true);
  expect(isWithinRoot('/tmp/shot.png', '/workspace')).toBe(false);
  expect(isWithinRoot('/workspace-other', '/workspace')).toBe(false);
});

test('navigateToPath allows non-workspace sandbox roots when unconstrained', () => {
  const store = createFilesStore();
  store.getState().navigateToPath('/tmp');
  expect(store.getState().currentPath).toBe('/tmp');
  expect(store.getState().expandedDirs.has('/tmp')).toBe(true);

  store.getState().navigateToPath('/home/user/downloads');
  expect(store.getState().currentPath).toBe('/home/user/downloads');
});

test('navigateToPath defaults to /workspace for an empty path', () => {
  const store = createFilesStore();
  store.getState().navigateToPath('');
  expect(store.getState().currentPath).toBe('/workspace');
});

test('navigateToPath clamps to rootPath when one is set', () => {
  const store = createFilesStore();
  store.getState().setRootPath('/workspace/project');
  store.getState().navigateToPath('/tmp');
  expect(store.getState().currentPath).toBe('/workspace/project');

  store.getState().navigateToPath('/workspace/project/src');
  expect(store.getState().currentPath).toBe('/workspace/project/src');
});

test('revealPath expands every ancestor of a non-workspace file', () => {
  const store = createFilesStore();
  store.getState().revealPath('/tmp/screens/shot.png');
  expect(store.getState().expandedDirs.has('/tmp')).toBe(true);
  expect(store.getState().expandedDirs.has('/tmp/screens')).toBe(true);
});
