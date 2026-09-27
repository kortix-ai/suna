import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { configureKortix } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

import { SANDBOX_HEALTH_QUERY_KEY } from '@/features/workspace/project-sidebar/footer/project-sandbox-alert';

import { prefetchProjectShellReads } from './project-shell-prefetch';

/**
 * The project shell's own reads (detail, sessions list, sandbox health, model
 * picker) used to wait for `ProjectAccessBoundary`'s `getProject` to resolve
 * AND for `ProjectShell`'s own chunk to mount. This starts them from the
 * boundary instead, at the same point `getProject` fires.
 */

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(gatewayEnabled: boolean) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('/detail')) {
      return Response.json({
        project: { id: 'P1', account_id: 'A1', experimental: { llm_gateway: gatewayEnabled } },
        config: {},
        file_count: 0,
        files: [],
        git_connection: null,
      });
    }
    if (String(url).includes('/sandbox-health')) {
      return Response.json({ sandboxes: [] });
    }
    if (String(url).includes('/model-picker')) {
      return Response.json({ models: [] });
    }
    if (String(url).includes('/sessions')) {
      return Response.json([]);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return urls;
}

describe('prefetchProjectShellReads', () => {
  test('issues detail, sessions and sandbox-health reads up front', async () => {
    const urls = mockFetch(false);
    const client = new QueryClient();
    prefetchProjectShellReads(client, 'P1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls.filter((u) => u.includes('/projects/P1/detail'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/projects/P1/sandbox-health'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/projects/P1/sessions'))).toHaveLength(1);
    client.clear();
  });

  test('seeds the exact cache entries their real hooks read', async () => {
    mockFetch(false);
    const client = new QueryClient();
    prefetchProjectShellReads(client, 'P1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.getQueryData(qk.project.detail('P1'))).toBeDefined();
    expect(client.getQueryData(qk.project.sessionsPaged('P1', 'visible'))).toBeDefined();
    expect(client.getQueryData(SANDBOX_HEALTH_QUERY_KEY('P1'))).toBeDefined();
    client.clear();
  });

  test('fetches the model picker once detail says the gateway is on', async () => {
    const urls = mockFetch(true);
    const client = new QueryClient();
    prefetchProjectShellReads(client, 'P1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls.filter((u) => u.includes('/model-picker'))).toHaveLength(1);
    expect(client.getQueryData(qk.project.modelPicker('P1'))).toBeDefined();
    client.clear();
  });

  test('never fetches the model picker for a gateway-disabled project', async () => {
    const urls = mockFetch(false);
    const client = new QueryClient();
    prefetchProjectShellReads(client, 'P1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls.filter((u) => u.includes('/model-picker'))).toHaveLength(0);
    client.clear();
  });

  test('missing project id issues no request', async () => {
    const urls = mockFetch(false);
    const client = new QueryClient();
    prefetchProjectShellReads(client, '');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls).toHaveLength(0);
    client.clear();
  });

  test('never throws when every read fails', async () => {
    globalThis.fetch = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    const client = new QueryClient();
    expect(() => prefetchProjectShellReads(client, 'P1')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.clear();
  });
});
