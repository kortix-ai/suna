import { expect, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';

configureKortix({ backendUrl: 'https://api.example.test/v1', getToken: async () => 'synthetic-token' });

/** One `/file` row as the sandbox daemon answers it. */
const node = (path: string, type: 'file' | 'directory') => ({
  name: path.split('/').pop(),
  path,
  absolute: `/workspace/${path}`,
  type,
  ignored: false,
});

const originalFetch = globalThis.fetch;
test('mobile service ranks shared path corpus', async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | Request | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const rows = new URL(url).pathname === '/file'
      ? url.includes('path=src') ? [node('src/app.ts', 'file'), node('src/app.test.ts', 'file')] : [node('src', 'directory')]
      : [];
    return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const { searchWorkspaceFilePaths } = await import('./workspace-search-service');
    expect(await searchWorkspaceFilePaths('https://example.test', 'src/app.ts')).toEqual([
      '/workspace/src/app.ts', '/workspace/src/app.test.ts',
    ]);
    expect(requested.every((url) => url.startsWith('https://example.test/'))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
