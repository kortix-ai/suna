import { afterEach, describe, expect, test } from 'bun:test';

import { configureKortix } from '../http/config';
import { openSessionBundle, resetSessionOpenBundles } from './open-bundle';
import { readProjectSessionRow } from './project-session-read';

/**
 * The session row on the OPEN path rides the session-open bundle.
 *
 * Staging HAR, 2026-09-23: opening a session issued `GET .../sessions/<id>`
 * beside `GET .../snapshot`, although the snapshot's `session` leg is the same
 * row. On a cold box the session page cannot resolve its OpenCode root without
 * that row, so the extra request sat on the path to the first transcript paint.
 */

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
});

const ROW = { session_id: 'S1', project_id: 'P1', opencode_session_id: 'ses_root' };

function mockFetch(body: (url: string) => unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    return Response.json(body(String(url)));
  }) as unknown as typeof fetch;
  return urls;
}

const bundleBody = {
  observed_at: '2026-09-23T12:00:00.000Z',
  session: ROW,
  turn: { known: true, turns: [] },
  queue: { known: true, prompts: [], held: false },
  transcript: { known: true, requested: false },
  config: { known: true, base_ref: null, agent_name: null, llm_gateway_enabled: false },
  models: { known: false, reason: 'x' },
};

describe('readProjectSessionRow', () => {
  test('answers the first read from an in-flight open bundle, with no row request', async () => {
    const urls = mockFetch((url) => (url.includes('/snapshot') ? bundleBody : { ...ROW, name: 'row' }));
    openSessionBundle('P1', 'S1');
    const row = await readProjectSessionRow('P1', 'S1', { bundle: true });
    expect(row.opencode_session_id).toBe('ses_root');
    expect(urls.filter((u) => u.endsWith('/sessions/S1'))).toHaveLength(0);
  });

  test('a refetch (bundle: false) asks the row endpoint even while a bundle is claimable', async () => {
    // A read issued because something changed — a rename, an invalidation —
    // must never be answered by a snapshot taken before the change.
    const urls = mockFetch((url) => (url.includes('/snapshot') ? bundleBody : { ...ROW, name: 'renamed' }));
    openSessionBundle('P1', 'S1');
    const row = await readProjectSessionRow('P1', 'S1', { bundle: false });
    expect((row as { name?: string }).name).toBe('renamed');
    expect(urls.filter((u) => u.endsWith('/sessions/S1'))).toHaveLength(1);
  });

  test('no bundle in flight: reads the row endpoint', async () => {
    const urls = mockFetch(() => ROW);
    const row = await readProjectSessionRow('P1', 'S1', { bundle: true });
    expect(row.session_id).toBe('S1');
    expect(urls).toHaveLength(1);
  });

  test('a failed bundle falls back to the row endpoint', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      if (String(url).includes('/snapshot')) return new Response('nope', { status: 500 });
      return Response.json(ROW);
    }) as unknown as typeof fetch;
    openSessionBundle('P1', 'S1');
    const row = await readProjectSessionRow('P1', 'S1', { bundle: true });
    expect(row.session_id).toBe('S1');
    expect(urls.filter((u) => u.endsWith('/sessions/S1'))).toHaveLength(1);
  });
});
