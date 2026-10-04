import { afterEach, describe, expect, mock, test } from 'bun:test';
import { GitHubApiError, getFileSha } from './github';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitHub file revision reads', () => {
  test('returns null only when the file is absent', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(
      getFileSha({
        owner: 'example',
        repo: 'repository',
        path: 'kortix.yaml',
        auth: { token: 'test-token', source: 'pat' },
      }),
    ).resolves.toBeNull();
  });

  test('preserves upstream failures', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ message: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(
      getFileSha({
        owner: 'example',
        repo: 'repository',
        path: 'kortix.yaml',
        auth: { token: 'test-token', source: 'pat' },
      }),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
