/**
 * `@kortix/sdk/react` must run on THIS app's React and React Query. The SDK
 * package has its own copies in `packages/sdk/node_modules` (React 19.3 beside
 * the app's 19.2), and a hook that runs on a second React throws "Invalid hook
 * call", while a second React Query never sees the app's `QueryClientProvider`.
 * Metro pins them in `metro.config.js`; `bun test` pins them in the
 * `lib/testing/sdk-single-instance.ts` preload. This test fails when that preload is
 * missing.
 */
import { expect, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRuntimeSessions, useRuntimePendingStore } from '@kortix/sdk/react';

test('an SDK query hook renders under the app QueryClientProvider', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const seen: string[] = [];
  function Probe() {
    // A React Query hook and a zustand hook, both from the SDK.
    const sessions = useRuntimeSessions({ enabled: false } as never);
    const pending = useRuntimePendingStore((state) => Object.keys(state.questions).length);
    seen.push(`${sessions.status}:${pending}`);
    return null;
  }
  const client = new QueryClient();
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => {
    tree = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  expect(seen.length).toBeGreaterThan(0);
  await act(async () => tree?.unmount());
  client.clear();
});
