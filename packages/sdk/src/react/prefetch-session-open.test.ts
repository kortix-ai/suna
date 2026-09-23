import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { configureKortix } from '../core/http/config';
import { claimOpenBundle, resetSessionOpenBundles } from '../core/session/open-bundle';
import { prefetchSessionOpen, resetSessionOpenPrefetches } from './prefetch-session-open';
import { qk } from './query-keys';

/**
 * Start a session's open read BEFORE the session page mounts.
 *
 * Staging HAR, 2026-09-23, cold session open: `GET /projects/<id>` (1.68 s)
 * and only THEN `GET .../snapshot?transcript=40` (3.45 s), because the session
 * page mounts under the project access boundary and the snapshot was issued
 * from the page. The snapshot needs nothing but the two route ids.
 */

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
  resetSessionOpenPrefetches();
});

const ROW = { session_id: 'S1', project_id: 'P1', opencode_session_id: 'ses_root' };
const BUNDLE = {
  observed_at: '2026-09-23T12:00:00.000Z',
  session: ROW,
  turn: { known: true, turns: [] },
  queue: { known: true, prompts: [], held: false },
  transcript: { known: true, requested: false },
  config: { known: true, base_ref: null, agent_name: null, llm_gateway_enabled: false },
  models: { known: false, reason: 'x' },
};

function mockFetch() {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    return Response.json(String(url).includes('/snapshot') ? BUNDLE : ROW);
  }) as unknown as typeof fetch;
  return urls;
}

describe('prefetchSessionOpen', () => {
  test('issues ONE snapshot read and seeds the session row from it', async () => {
    const urls = mockFetch();
    const client = new QueryClient();
    await prefetchSessionOpen(client, 'P1', 'S1');
    expect(urls.filter((u) => u.includes('/sessions/S1/snapshot'))).toHaveLength(1);
    // The row came from the snapshot's `session` leg — no second request.
    expect(urls.filter((u) => u.endsWith('/sessions/S1'))).toHaveLength(0);
    expect(client.getQueryData(qk.project.session('P1', 'S1'))).toEqual(ROW);
    client.clear();
  });

  test('leaves the bundle claimable for the page that mounts next', async () => {
    mockFetch();
    const client = new QueryClient();
    void prefetchSessionOpen(client, 'P1', 'S1');
    // The page's `/turn` and `/prompts` reads and its transcript hydrate claim
    // this in-flight read instead of starting their own.
    expect(claimOpenBundle('P1', 'S1')).not.toBeNull();
    client.clear();
  });

  test('repeat intents for one session inside the window cost nothing', async () => {
    // Hover, focus and touch all signal intent, and a pointer crossing a row
    // twice must not pay twice.
    const urls = mockFetch();
    const client = new QueryClient();
    await prefetchSessionOpen(client, 'P1', 'S1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await prefetchSessionOpen(client, 'P1', 'S1');
    expect(urls.filter((u) => u.includes('/snapshot'))).toHaveLength(1);
    client.clear();
  });

  test('missing ids issue no request', async () => {
    const urls = mockFetch();
    const client = new QueryClient();
    await prefetchSessionOpen(client, '', 'S1');
    await prefetchSessionOpen(client, 'P1', '');
    expect(urls).toHaveLength(0);
    client.clear();
  });

  test('never rejects when the snapshot fails', async () => {
    globalThis.fetch = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const client = new QueryClient();
    await expect(prefetchSessionOpen(client, 'P1', 'S1')).resolves.toBeUndefined();
    client.clear();
  });
});
