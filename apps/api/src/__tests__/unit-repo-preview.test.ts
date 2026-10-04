import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// GitHub's social preview exists only for a public repository. For a private
// or missing one the image service answered 429, then a generic placeholder
// (measured 2026-09-29), and Teams drew a broken image beside every
// Kortix-hosted project. The repository page decides: 200 public, 404 not.

mock.module('../lib/config', () => ({ config: { MANAGED_GIT_GITHUB_OWNER: 'managed-kortix' } }));
const { isKortixHostedRepo, repoDisplayLabel, repoPreviewImages, resetRepoPreviewCache } = await import('../services/channels/repo-preview');

const PUBLIC = 'https://github.com/octocat/Hello-World';
const PRIVATE = 'https://github.com/acme/secret-app';
const HOSTED = 'https://github.com/managed-kortix/demo-11111111-1111-4111-8111-111111111111';

let requests: Array<{ url: string; method?: string }> = [];
const fetchImpl = async (url: string, init: RequestInit) => {
  requests.push({ url, method: init.method });
  if (url === 'https://github.com/octocat/Hello-World') return new Response(null, { status: 200 });
  if (url === 'https://github.com/slow/repo') return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 200 })), 200));
  if (url === 'https://github.com/rate/limited') return new Response('Too Many Requests', { status: 429 });
  return new Response('Not Found', { status: 404 });
};

beforeEach(() => {
  requests = [];
  resetRepoPreviewCache();
});
afterAll(() => mock.restore());

describe('repoPreviewImages', () => {
  test('a public repository gets its preview; a private or missing one (404) and a refused check (429) get none', async () => {
    const images = await repoPreviewImages([PUBLIC, PRIVATE, 'https://github.com/rate/limited'], { fetchImpl });
    expect([...images.entries()]).toEqual([[PUBLIC, 'https://opengraph.githubassets.com/1/octocat/Hello-World']]);
    expect(requests).toContainEqual({ url: 'https://github.com/octocat/Hello-World', method: 'HEAD' });
  });

  test('a Kortix-hosted repository is never fetched', async () => {
    const images = await repoPreviewImages([HOSTED], { fetchImpl });
    expect(images.size).toBe(0);
    expect(requests).toEqual([]);
  });

  test('each repository is probed once, then served from the cache, hit or miss', async () => {
    await repoPreviewImages([PUBLIC, PRIVATE, PUBLIC], { fetchImpl });
    await repoPreviewImages([PUBLIC, PRIVATE], { fetchImpl });
    expect(requests).toHaveLength(2);
  });

  test('a slow probe does not hold the card past waitMs; the next card gets its result', async () => {
    const slow = 'https://github.com/slow/repo';
    expect((await repoPreviewImages([slow], { fetchImpl, waitMs: 20 })).size).toBe(0);
    await new Promise((r) => setTimeout(r, 250));
    expect((await repoPreviewImages([slow], { fetchImpl, waitMs: 20 })).get(slow)).toBe('https://opengraph.githubassets.com/1/slow/repo');
    expect(requests).toHaveLength(1);
  });

  test('a network failure is treated as no preview', async () => {
    const images = await repoPreviewImages([PUBLIC], { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    expect(images.size).toBe(0);
  });
});

describe('repo labels', () => {
  test('a Kortix-hosted repository reads "Hosted by Kortix", not its internal name', () => {
    expect(isKortixHostedRepo(HOSTED)).toBe(true);
    expect(isKortixHostedRepo(PUBLIC)).toBe(false);
    expect(repoDisplayLabel(HOSTED)).toBe('Hosted by Kortix');
    expect(repoDisplayLabel(PUBLIC)).toBe('octocat/Hello-World');
    expect(repoDisplayLabel(null)).toBeNull();
  });

  test('with no hosting org configured (self-host without one), nothing is hosted', () => {
    expect(isKortixHostedRepo(HOSTED, '')).toBe(false);
  });
});
