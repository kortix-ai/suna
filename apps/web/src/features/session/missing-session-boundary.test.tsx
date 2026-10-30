import { SessionStartError, sessionStartKey } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test } from 'bun:test';
import { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MissingSessionBoundary } from './missing-session-boundary';

let renderer: ReactTestRenderer | undefined;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => {
  act(() => renderer?.unmount());
  client.clear();
});

test('a definitive missing-session answer unmounts live readers, but a transient failure does not', async () => {
  let mounted = false;
  function LiveReaders() {
    useEffect(() => {
      mounted = true;
      return () => {
        mounted = false;
      };
    }, []);
    return <span>Live session</span>;
  }
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MissingSessionBoundary
          projectId="project"
          sessionId="session"
          fallback={<span>Session not found</span>}
        >
          <LiveReaders />
        </MissingSessionBoundary>
      </QueryClientProvider>,
    );
  });
  expect(mounted).toBe(true);
  const key = sessionStartKey('project', 'session');
  async function fail(status: number) {
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: key,
          queryFn: async () => {
            throw new SessionStartError('request failed', { status, terminal: status === 404 });
          },
        })
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  await fail(503);
  expect(mounted).toBe(true);
  await fail(404);
  expect(mounted).toBe(false);
  expect(JSON.stringify(renderer?.toJSON())).toContain('Session not found');
});

test('a retrying fresh-session miss does not remove its start owner', async () => {
  let finishRetry: (() => void) | undefined;
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MissingSessionBoundary
          projectId="project"
          sessionId="fresh"
          fallback={<span>Missing</span>}
        >
          <span>Starting</span>
        </MissingSessionBoundary>
      </QueryClientProvider>,
    );
  });
  let calls = 0;
  const request = client.fetchQuery({
    queryKey: sessionStartKey('project', 'fresh'),
    queryFn: async () => {
      calls++;
      if (calls === 1)
        throw new SessionStartError('create pending', { status: 404, terminal: true });
      await new Promise<void>((resolve) => {
        finishRetry = resolve;
      });
      return { sandbox_id: 'sandbox' };
    },
    retry: 1,
    retryDelay: 1,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(calls).toBe(2);
  expect(JSON.stringify(renderer?.toJSON())).toContain('Starting');
  await act(async () => {
    finishRetry?.();
    await request;
  });
  expect(JSON.stringify(renderer?.toJSON())).toContain('Starting');
});
