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

test('a store held to `/` (Files) opens any folder, and home is `/`, never /workspace', () => {
  const store = createFilesStore();
  store.getState().setRootPath('/');
  expect(isWithinRoot('Users/ana', '/')).toBe(true);
  store.getState().navigateToPath('Users/ana');
  expect(store.getState().currentPath).toBe('Users/ana');
  store.getState().navigateToPath('');
  expect(store.getState().currentPath).toBe('/');
});

// KRTX-1723: a content-search hit opens its file at the matched line. The line
// belongs to that one file: moving to another file must not scroll it there too.
test('openFile keeps the target line until another file or the browser shows', () => {
  const store = createFilesStore();
  store.getState().openFile('/workspace/a.ts', 42);
  expect(store.getState().targetLine).toBe(42);

  store.getState().openFileWithList('/workspace/b.ts', ['/workspace/b.ts'], 0);
  expect(store.getState().targetLine).toBeNull();

  store.getState().openFile('/workspace/a.ts', 7);
  store.getState().goBackToBrowser();
  expect(store.getState().targetLine).toBeNull();
});

test('next and previous file drop the target line', () => {
  const store = createFilesStore();
  const list = ['/workspace/a.ts', '/workspace/b.ts'];
  store.getState().openFileWithList(list[0], list, 0);
  store.setState({ targetLine: 12 });
  store.getState().nextFile();
  expect(store.getState().selectedFilePath).toBe(list[1]);
  expect(store.getState().targetLine).toBeNull();

  store.setState({ targetLine: 12 });
  store.getState().prevFile();
  expect(store.getState().selectedFilePath).toBe(list[0]);
  expect(store.getState().targetLine).toBeNull();
});
