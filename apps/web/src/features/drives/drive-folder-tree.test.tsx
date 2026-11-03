import type { Drive, DriveEntry } from '@kortix/sdk';
import { createFilesStore, FilesStoreProvider } from '@kortix/ui/internal/stores/files-store';
import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';

const win = new Window();
Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
Object.defineProperty(globalThis, 'document', { value: win.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let entries: DriveEntry[] = [];
let status = { isLoading: false, isError: false, isSuccess: true, isFetching: false };
const { getFileIcon } =
  await import('../../../../../packages/ui/src/files/project/components/file-icon');
mock.module('@kortix/ui/files', () => ({
  getFileIcon,
  useDriveFolder: () => ({ data: { entries }, ...status, refetch: () => {} }),
}));
const store = createFilesStore();
const { createRoot } = await import('react-dom/client');
const { DriveFolderTree } = await import('./drive-folder-tree');
const drive: Drive = {
  driveId: 'synthetic-drive',
  accountId: 'synthetic-account',
  projectId: 'synthetic-project',
  kind: 'project',
  name: 'Test drive',
  sizeBytes: 0,
  sizeLimitBytes: null,
  fileCount: 0,
  lastChangeAt: null,
  createdAt: '',
  updatedAt: '',
  access: 'manage',
  personalFolder: null,
  sharedDrives: true,
};
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  status = { isLoading: false, isError: false, isSuccess: true, isFetching: false };
  store.getState().goBackToBrowser();
});
function entry(name: string, type: DriveEntry['type']): DriveEntry {
  return { name, path: `/${name}`, type, size: 0, mtime: 0, access: 'manage' };
}
async function render(items: DriveEntry[], state = status) {
  status = state;
  entries = items;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <FilesStoreProvider store={store}>
        <DriveFolderTree drive={drive} rootLabel="Test drive" path="/" onOpen={() => {}} />
      </FilesStoreProvider>,
    ),
  );
}
test('files-only directories render file children and retain their collapse control', async () => {
  await render([entry('notes.txt', 'file')]);
  expect(document.querySelector('button[title="notes.txt"]')).not.toBeNull();
  expect(document.querySelector('[role="treeitem"][aria-expanded="true"]')).not.toBeNull();
  const collapse = document.querySelector<HTMLButtonElement>(
    '[role="treeitem"][aria-expanded="true"] > div > button[aria-label]',
  );
  expect(collapse).not.toBeNull();
  await act(async () => collapse?.click());
  expect(document.querySelector('button[title="notes.txt"]')).toBeNull();
});
test('mixed directories show folders before alphabetically ordered visible files', async () => {
  await render([
    entry('z.txt', 'file'),
    entry('a.txt', 'file'),
    entry('Folder', 'dir'),
    entry('.hidden', 'file'),
  ]);
  const names = Array.from(
    document.querySelectorAll('[role="tree"] > li > ul > li button[title]'),
    (button) => button.getAttribute('title'),
  );
  expect(names).toEqual(['Folder', 'a.txt', 'z.txt']);
});
test('empty directories do not claim they can expand', async () => {
  await render([]);
  expect(document.querySelector('[role="treeitem"][aria-expanded]')).toBeNull();
});

test('selecting a file opens the shared preview with its sibling file list', async () => {
  await render([entry('a.txt', 'file'), entry('b.txt', 'file')]);
  const file = document.querySelector<HTMLButtonElement>('button[title="b.txt"]');
  await act(async () => file?.click());
  expect(store.getState().selectedFilePath).toBe('/b.txt');
  expect(store.getState().filePathList).toEqual(['/a.txt', '/b.txt']);
  expect(store.getState().currentFileIndex).toBe(1);
  expect(store.getState().view).toBe('viewer');
});

for (const state of [
  { isLoading: true, isError: false, isSuccess: false, isFetching: true },
  { isLoading: false, isError: true, isSuccess: false, isFetching: false },
  { isLoading: false, isError: false, isSuccess: true, isFetching: true },
]) {
  test(`unknown or refreshing listings retain a folder chevron: ${JSON.stringify(state)}`, async () => {
    await render([], state);
    expect(document.querySelector('[role="treeitem"][aria-expanded="true"]')).not.toBeNull();
    expect(document.querySelector('[role="treeitem"] > div > button[aria-label]')).not.toBeNull();
  });
}
