import { expect, test } from 'bun:test';
import { createWorkspaceSearchClient } from './client';

test('traverses deep paths and ranks exact matches before partial matches', async () => {
  const directories: Record<string, {path:string;type:string}[]> = {
    '/workspace': [{path:'/workspace/src',type:'directory'}, {path:'/workspace/build',type:'directory'}],
    '/workspace/src': [{path:'/workspace/src/app.ts',type:'file'}, {path:'/workspace/src/app.test.ts',type:'file'}],
    '/workspace/build': [{path:'/workspace/build/app.ts',type:'file'}],
  };
  const client = createWorkspaceSearchClient({
    listFiles: async (path) => directories[path] ?? [],
    findFiles: async () => [],
  });
  expect(await client.searchWorkspaceFilePaths('src/app.ts')).toEqual(['/workspace/src/app.ts', '/workspace/src/app.test.ts']);
});

test('reuses the index for a missing backend search', async () => {
  let calls = 0;
  const client = createWorkspaceSearchClient({
    listFiles: async (path) => { calls++; return path === '/workspace' ? [{path:'/workspace/alpha.ts',type:'file'}] : []; },
    findFiles: async () => [],
  });
  expect(await client.searchWorkspaceFilePaths('alpha')).toEqual(['/workspace/alpha.ts']);
  expect(await client.searchWorkspaceFilePaths('alpha')).toEqual(['/workspace/alpha.ts']);
  expect(calls).toBe(1);
});
