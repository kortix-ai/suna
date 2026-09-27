import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { configureKortix, sessionStartKey } from '@kortix/sdk';

import { sessionConfigKey } from '@/hooks/projects/use-session-config-freshness';
import { sessionScopeQueryKey } from '@/features/session/scope/use-session-scope';

import { prefetchSessionRouteReads } from './session-route-prefetch';

/**
 * `/start`, `/config` and `/scope` used to fire only once `ProjectSessionView`'s
 * own route segment mounted — well after `ProjectAccessBoundary`'s
 * `prefetchSessionOpen` had already started the snapshot from the SAME two
 * route ids. This starts them from that same early point instead.
 */

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch() {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('/start')) {
      return Response.json({ stage: 'provisioning', sandbox: null, retriable: true });
    }
    if (String(url).includes('/config')) {
      return Response.json({
        base_ref: 'main',
        running_etag: null,
        latest_etag: null,
        commit_sha: null,
        stale: null,
        sandbox_reachable: false,
      });
    }
    if (String(url).includes('/scope')) {
      return Response.json({ secrets: [], connector_connections: [] });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return urls;
}

describe('prefetchSessionRouteReads', () => {
  test('issues exactly one start, one config and one scope read', async () => {
    const urls = mockFetch();
    const client = new QueryClient();
    prefetchSessionRouteReads(client, 'P1', 'S1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls.filter((u) => u.includes('/sessions/S1/start'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/sessions/S1/config'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/sessions/S1/scope'))).toHaveLength(1);
    client.clear();
  });

  test('the /start read carries the same wait budget useSession defaults to (15s)', async () => {
    const urls = mockFetch();
    const client = new QueryClient();
    prefetchSessionRouteReads(client, 'P1', 'S1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const started = urls.find((u) => u.includes('/sessions/S1/start'));
    expect(started).toContain('wait_ms=15000');
    client.clear();
  });

  test('seeds the exact cache entries the real hooks read', async () => {
    mockFetch();
    const client = new QueryClient();
    prefetchSessionRouteReads(client, 'P1', 'S1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.getQueryData(sessionStartKey('P1', 'S1'))).toBeDefined();
    expect(client.getQueryData(sessionConfigKey('P1', 'S1'))).toBeDefined();
    expect(client.getQueryData(sessionScopeQueryKey('P1', 'S1'))).toBeDefined();
    client.clear();
  });

  test('missing ids issue no request', async () => {
    const urls = mockFetch();
    const client = new QueryClient();
    prefetchSessionRouteReads(client, '', 'S1');
    prefetchSessionRouteReads(client, 'P1', '');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls).toHaveLength(0);
    client.clear();
  });

  test('never throws when every read fails', async () => {
    globalThis.fetch = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const client = new QueryClient();
    expect(() => prefetchSessionRouteReads(client, 'P1', 'S1')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.clear();
  });
});
