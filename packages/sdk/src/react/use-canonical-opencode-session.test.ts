import { afterEach, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import React from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';
import { configureKortix } from '../core/http/config';
import { resetSessionOpenBundles } from '../core/session/open-bundle';
import { useCanonicalOpenCodeSession } from './use-canonical-opencode-session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
let client: QueryClient;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  globalThis.fetch = originalFetch;
  resetSessionOpenBundles();
});

const SESSION_ID = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function row(pin: string | null) {
  return { session_id: SESSION_ID, project_id: 'p1', opencode_session_id: pin, metadata: {} };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function mount(params: { pinFromStart?: string | null; initialPin?: string | null }) {
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let value!: ReturnType<typeof useCanonicalOpenCodeSession>;
  function Probe() {
    value = useCanonicalOpenCodeSession({
      projectId: 'p1',
      sessionId: SESSION_ID,
      listRuntimeSessions: false,
      ...params,
    });
    return null;
  }
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  await settle();
  return () => value;
}

test('a pin handed over by /start or by the host is settled at once, with no read', async () => {
  const fetcher = mock(async () => Response.json(row('ses_row')));
  globalThis.fetch = fetcher as unknown as typeof fetch;
  const fromStart = await mount({ pinFromStart: 'ses_start' });
  expect(fromStart().rootSessionId).toBe('ses_start');
  expect(fromStart().pinSettled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

test('with no pin, the session-row read keeps it pending until the row answers', async () => {
  let answer!: (response: Response) => void;
  globalThis.fetch = mock(
    async () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  ) as unknown as typeof fetch;
  const value = await mount({});
  expect(value().rootSessionId).toBeNull();
  expect(value().pinSettled).toBe(false);
  await act(async () => {
    answer(Response.json(row(null)));
  });
  await settle();
  // The row answered and names no root: only the runtime can supply one now.
  expect(value().rootSessionId).toBeNull();
  expect(value().pinSettled).toBe(true);
});

test('the row read supplies the root when it carries a pin', async () => {
  globalThis.fetch = mock(async () => Response.json(row('ses_row'))) as unknown as typeof fetch;
  const value = await mount({});
  expect(value().rootSessionId).toBe('ses_row');
  expect(value().pinSettled).toBe(true);
});

test('a failed row read settles it: no control-plane read is left to supply a root', async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ error: 'boom' }, { status: 500 }),
  ) as unknown as typeof fetch;
  const value = await mount({});
  expect(value().rootSessionId).toBeNull();
  expect(value().pinSettled).toBe(true);
});

test('a row read being fetched again is not settled, even after an earlier failure', async () => {
  let answer: ((response: Response) => void) | null = null;
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls++;
    if (calls === 1) return Response.json({ error: 'boom' }, { status: 500 });
    return new Promise<Response>((resolve) => {
      answer = resolve;
    });
  }) as unknown as typeof fetch;
  const value = await mount({});
  expect(value().pinSettled).toBe(true);
  // The session page refetches the row once a signed-in user arrives.
  await act(async () => {
    void client.refetchQueries();
  });
  await settle();
  expect(value().pinSettled).toBe(false);
  await act(async () => {
    answer?.(Response.json(row('ses_row')));
  });
  await settle();
  expect(value().rootSessionId).toBe('ses_row');
  expect(value().pinSettled).toBe(true);
});

test('a row read waiting for the network (offline) is not settled', async () => {
  onlineManager.setOnline(false);
  try {
    globalThis.fetch = mock(async () => Response.json(row('ses_row'))) as unknown as typeof fetch;
    const value = await mount({});
    expect(value().rootSessionId).toBeNull();
    expect(value().pinSettled).toBe(false);
  } finally {
    onlineManager.setOnline(true);
  }
});
