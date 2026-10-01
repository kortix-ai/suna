import { expect, test, mock } from 'bun:test';

mock.module('@/api/config', () => ({ getAuthToken: async () => null }));
const originalFetch = globalThis.fetch;
test('mobile service ranks shared path corpus', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    const paths = url.includes('/file?')
      ? url.includes('path=%2Fworkspace%2Fsrc') ? ['/workspace/src/app.ts', '/workspace/src/app.test.ts'] : ['/workspace/src/']
      : [];
    return new Response(JSON.stringify(paths), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const { searchWorkspaceFilePaths } = await import('./workspace-search-service');
    expect(await searchWorkspaceFilePaths('https://example.test', 'src/app.ts')).toEqual([
      '/workspace/src/app.ts', '/workspace/src/app.test.ts',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
