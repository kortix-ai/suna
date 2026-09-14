import { expect, mock, test } from 'bun:test';
import { fileContentKeys, fileListKeys, gitStatusKeys } from '../../../../../../packages/sdk/src/react/file-keys';

mock.module('@kortix/sdk/react', () => ({
  fileContentKeys, fileListKeys, gitStatusKeys,
  useRuntimeStore: (select: (state: unknown) => unknown) => select({ getActiveWorkspaceUrl: () => 'workspace-url' }),
}));
mock.module('@tanstack/react-query', () => ({ useQuery: (options: unknown) => options, useQueryClient: () => ({}) }));
mock.module('react', () => ({ useMemo: (factory: () => unknown) => factory() }));
mock.module('@/features/file-browser/store/files-store', () => ({ useFilesStore: () => false }));
mock.module('./use-server-health', () => ({ useServerHealth: () => ({ data: { healthy: true } }), useCurrentProject: () => ({ data: { vcs: 'git' } }) }));
mock.module('../api/runtime-files', () => ({ readFile: () => {}, listFiles: () => {}, getFileStatus: () => {} }));

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
