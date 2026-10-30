/**
 * `/v1/platform/sandbox/version/*` — the public sandbox release feed.
 *
 * The API reads GitHub Releases without a token: 60 requests per hour per
 * egress IP. Before KRTX-3152 every endpoint fetched on its own, `/changelog`
 * never cached, and `/latest` cached only a success, so the mobile app's
 * 10-minute poll kept the budget at zero and every endpoint answered empty.
 * The feed now makes one shared read per 10 minutes, backs off 60 s after a
 * failure, and keeps serving the last good copy.
 *
 * The router keeps its cache at module scope, so the steps below share one
 * module and run in order (`bun test --isolate` gives this file its own).
 */
import { afterAll, beforeAll, expect, setSystemTime, test } from 'bun:test';

const RELEASES = [
  { tag_name: 'dev-latest', name: 'dev-latest', published_at: '2026-05-31T00:00:00Z', body: '', draft: false, prerelease: true },
  { tag_name: 'v0.14.7', name: 'v0.14.7 — Stable', published_at: '2026-10-22T00:00:00Z', body: 'notes', draft: false, prerelease: false },
  { tag_name: 'v0.14.8', name: 'v0.14.8 draft', published_at: '2026-10-23T00:00:00Z', body: '', draft: true, prerelease: false },
];

let githubUp = true;
let githubCalls = 0;
const realFetch = globalThis.fetch;
const { versionRouter } = await import('./version');

beforeAll(() => {
  setSystemTime(new Date('2026-10-23T12:00:00Z'));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.github.com/')) {
      githubCalls += 1;
      // A real round trip: concurrent requests must find the read in flight.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return githubUp
        ? new Response(JSON.stringify(RELEASES), { status: 200 })
        : new Response('{"message":"API rate limit exceeded"}', { status: 403 });
    }
    return new Response('{"message":"object not found"}', { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
});

function advance(ms: number) {
  setSystemTime(new Date(Date.now() + ms));
}

async function get(path: string) {
  const res = await versionRouter.request(path);
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}

test('a failed GitHub read backs off for 60 s instead of re-fetching on every request', async () => {
  githubUp = false;
  expect(await get('/latest')).toMatchObject({ version: 'unknown', title: 'No stable release available' });
  expect(await get('/latest')).toMatchObject({ version: 'unknown' });
  expect(await get('/changelog?channel=stable')).toEqual({ changelog: [] });
  expect(githubCalls).toBe(1);
});

test('latest stable skips prereleases and drafts, and one read serves every endpoint, concurrent requests too', async () => {
  githubUp = true;
  advance(61_000);
  const before = githubCalls;

  const [latest, allBody] = await Promise.all([get('/latest'), get('/all')]);
  expect(latest).toEqual({
    version: '0.14.7',
    channel: 'stable',
    date: '2026-10-22',
    title: 'v0.14.7 — Stable',
  });
  const changelog = (await get('/changelog?channel=stable')).changelog as Array<{ version: string }>;
  expect(changelog.map((entry) => entry.version)).toEqual(['0.14.7']);
  const all = allBody.versions as Array<{ version: string; channel: string }>;
  expect(all.map(({ version, channel }) => `${version}:${channel}`)).toEqual(['0.14.7:stable', 'dev-latest:dev']);

  expect(githubCalls - before).toBe(1);
});

test('after the TTL a failed refresh keeps serving the last good copy', async () => {
  githubUp = false;
  advance(11 * 60_000);
  const before = githubCalls;

  expect(await get('/latest')).toMatchObject({ version: '0.14.7', channel: 'stable' });
  expect(await get('/latest')).toMatchObject({ version: '0.14.7' });
  const changelog = (await get('/changelog?channel=stable')).changelog as Array<{ version: string }>;
  expect(changelog.map((entry) => entry.version)).toEqual(['0.14.7']);

  expect(githubCalls - before).toBe(1);
});
