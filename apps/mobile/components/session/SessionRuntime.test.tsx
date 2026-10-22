import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '@kortix/sdk';

import { SessionRuntimeProvider, useSessionRuntime, type BoundSession } from './SessionRuntime';

/**
 * The one `useSession` of the app. Unbound (project home, signed out) it must
 * ask the server nothing; bound, it drives `/start` for exactly that session.
 */

const originalFetch = globalThis.fetch;
let urls: string[] = [];
let seen: Array<ReturnType<typeof useSessionRuntime>> = [];
let tree: ReactTestRenderer | undefined;
let client: QueryClient;

function Probe() {
  seen.push(useSessionRuntime());
  return null;
}

async function render(session: BoundSession | null) {
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <SessionRuntimeProvider session={session}>
          <Probe />
        </SessionRuntimeProvider>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  urls = [];
  seen = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input instanceof Request ? input.url : input));
    // A session that is still starting: nothing switches in.
    return Response.json({ stage: 'starting', retriable: true, sandbox: null });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  if (tree) await act(async () => tree?.unmount());
  tree = undefined;
  client.clear();
  globalThis.fetch = originalFetch;
});

test('unbound: no request, and no runtime for the screens', async () => {
  await render(null);
  expect(urls).toEqual([]);
  expect(seen.at(-1)).toBeNull();
});

test('bound: it starts that session and hands the screens its runtime', async () => {
  await render({ projectId: 'p1', sessionId: '11111111-1111-4111-8111-111111111111' });
  expect(urls.some((url) => url.includes('/projects/p1/sessions/11111111-1111-4111-8111-111111111111/start'))).toBe(true);
  const runtime = seen.at(-1);
  expect(runtime).not.toBeNull();
  // Not ready yet: the screens wait, and nothing is bound.
  expect(runtime?.switched).toBe(false);
  expect(runtime?.runtimeSessionId).toBeNull();
});
