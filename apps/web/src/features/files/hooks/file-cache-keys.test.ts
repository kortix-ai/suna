import { expect, mock, test } from 'bun:test';
const { binaryBlobKeys, fileContentKeys, fileListKeys, gitStatusKeys } = await import('@kortix/sdk/react');

mock.module('@kortix/sdk/react', () => ({
  binaryBlobKeys, fileContentKeys, fileListKeys, gitStatusKeys,
  useRuntimeStore: (select: (state: unknown) => unknown) => select({ getActiveWorkspaceUrl: () => 'workspace-url' }),
}));
let lastQuery: { queryKey: unknown };
mock.module('@tanstack/react-query', () => ({ useQuery: (options: { queryKey: unknown }) => { lastQuery = options; return options; }, useQueryClient: () => ({}) }));
mock.module('react', () => ({ useMemo: (factory: () => unknown) => factory(), useState: (value: unknown) => [value, () => {}], useEffect: () => {} }));
mock.module('@/features/file-browser/store/files-store', () => ({ useFilesStore: () => false }));
mock.module('./use-server-health', () => ({ useServerHealth: () => ({ data: { healthy: true } }), useCurrentProject: () => ({ data: { vcs: 'git' } }) }));
mock.module('../api/runtime-files', () => ({ readFile: () => {}, readFileAsBlob: () => {}, listFiles: () => {}, getFileStatus: () => {} }));

const { useFileContent } = await import('./use-file-content');
const { useFileList } = await import('./use-file-list');
const { useGitStatus } = await import('./use-git-status');

test('file contents use the cache invalidated by SDK history events', () => {
  expect((useFileContent('/workspace/a') as unknown as { queryKey: unknown }).queryKey).toEqual(fileContentKeys.file('workspace-url', '/workspace/a'));
});
test('directory listings use the cache invalidated by SDK history events', () => {
  expect((useFileList('/workspace') as unknown as { queryKey: unknown }).queryKey).toEqual(fileListKeys.dir('workspace-url', '/workspace'));
});
test('Git status uses the cache invalidated by SDK history events', () => {
  expect((useGitStatus() as unknown as { queryKey: unknown }).queryKey).toEqual(gitStatusKeys.status('workspace-url'));
});

const { useBinaryBlob } = await import('./use-binary-blob');
test('binary previews use the cache invalidated by SDK history events', () => {
  useBinaryBlob('/workspace/a.docx');
  expect(lastQuery.queryKey).toEqual(binaryBlobKeys.file('workspace-url', '/workspace/a.docx'));
});
