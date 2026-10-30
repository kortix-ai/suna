import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { CanResult } from './use-permission';

// A host that fronts one operator key blocks the account routes
// (`accountApiEnabled: false`). Then no IAM probe may leave the browser, and
// every gate shows its control: the server enforces each route.

describe('permission gates — accountApiEnabled', () => {
  async function render(accountApiEnabled: boolean) {
    const { act, create } = await import('react-test-renderer');
    const { UiProvider } = await import('../../providers/ui-provider');
    const { useCans, usePermission } = await import('./use-permission');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response('{}', { status: 403 });
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seen: { cans?: Record<string, CanResult>; one?: CanResult } = {};
    const ACTIONS = ['project.secret.read', 'project.write'] as const;
    function Probe() {
      seen.cans = useCans({ projectId: 'p1', accountId: 'a1' }, ACTIONS);
      seen.one = usePermission('a1', 'member.update');
      return null;
    }
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(
          <QueryClientProvider client={client}>
            <UiProvider config={{ accountApiEnabled }} useViewerId={() => 'u1'}>
              <Probe />
            </UiProvider>
          </QueryClientProvider>,
        );
      });
    } finally {
      await act(async () => root?.unmount());
      client.clear();
      globalThis.fetch = realFetch;
    }
    return { fetched, seen };
  }

  test('false: no probe runs and every gate is allowed', async () => {
    const { fetched, seen } = await render(false);
    expect(fetched).toEqual([]);
    expect(seen.cans?.['project.secret.read']).toMatchObject({ allowed: true, isLoading: false });
    expect(seen.cans?.['project.write']).toMatchObject({ allowed: true, isLoading: false });
    expect(seen.one).toMatchObject({ allowed: true, isLoading: false });
  });

  test('true (the default): gates wait on the probe', async () => {
    const { seen } = await render(true);
    expect(seen.cans?.['project.secret.read']?.allowed).toBe(false);
  });
});
