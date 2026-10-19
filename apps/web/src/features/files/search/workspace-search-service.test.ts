import { expect, test, mock } from 'bun:test';

mock.module('@kortix/ui/shared/features/files/api/runtime-files', () => ({
  findFiles: async () => [],
  listFiles: async (path: string) => path === '/workspace'
    ? [{ path: '/workspace/src', type: 'directory' }]
    : [{ path: '/workspace/src/app.ts', type: 'file' }, { path: '/workspace/src/app.test.ts', type: 'file' }],
}));
mock.module('@kortix/sdk/react', () => ({ getRuntimeCacheKey: () => 'characterization' }));

const { searchWorkspaceFilePaths } = await import('./workspace-search-service');
test('web service ranks shared path corpus', async () => {
  expect(await searchWorkspaceFilePaths('src/app.ts')).toEqual([
    '/workspace/src/app.ts', '/workspace/src/app.test.ts',
  ]);
});
