/**
 * The sandbox release feed with a GitHub token that the kortix-ai org rejects.
 *
 * KRTX-3152: dev, staging and prod set GITHUB_TOKEN to fine-grained tokens with
 * a lifetime over 366 days. The org forbids those, so GitHub answers 403 to
 * every kortix-ai request made with them, and the feed stayed empty. The repo
 * is public: a rejected token falls back to an anonymous read.
 *
 * `config` reads GITHUB_TOKEN at import, so this file sets it before importing
 * the router (`bun test --isolate` gives the file its own modules).
 */
import { afterAll, expect, test } from 'bun:test';

const RELEASES = [
  { tag_name: 'v0.14.7', name: 'v0.14.7', published_at: '2026-10-22T00:00:00Z', body: '', draft: false, prerelease: false },
];

process.env.GITHUB_TOKEN = 'synthetic-rejected-token';
const realFetch = globalThis.fetch;
const githubAuth: Array<string | null> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.github.com/')) return new Response('{}', { status: 404 });
  const auth = new Headers(init?.headers).get('authorization');
  githubAuth.push(auth);
  return auth
    ? new Response('{"message":"The \'kortix-ai\' organization forbids access via a fine-grained personal access tokens if the token\'s lifetime is greater than 366 days."}', { status: 403 })
    : new Response(JSON.stringify(RELEASES), { status: 200 });
}) as typeof fetch;

const { versionRouter } = await import('./version');

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.GITHUB_TOKEN;
});

test('a token GitHub rejects falls back to an anonymous read of the public releases', async () => {
  const res = await versionRouter.request('/latest');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ version: '0.14.7', channel: 'stable' });
  expect(githubAuth).toEqual(['Bearer synthetic-rejected-token', null]);
});
