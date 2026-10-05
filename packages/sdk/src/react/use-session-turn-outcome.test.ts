import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { qk } from './query-keys';
import { TURN_END_SETTLE_MS } from '../core/session/turn-end-settle';
import { useSessionTurnOutcome } from './use-session-working';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// `useSessionWorking` owns the ONE `/turn` poll per session. This hook reads the
// same cache entry and must never start a request of its own.
test('reads last_ended and recent_failures from the shared /turn cache entry and never fetches', async () => {
  const fetchSpy = mock(async () => Response.json({}));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lastEnded = {
    turn_token: 'tok',
    message_id: 'msg_u2',
    end_reason: 'failed',
    ended_at: '2026-09-18T13:42:49.000Z',
    error: { name: 'SandboxMemoryGuard', message: 'sandbox memory at 97%' },
  };

  const recentFailures = [{ message_id: 'msg_u1', ended_at: null, error: { name: 'SandboxMemoryGuard', message: 'sandbox memory at 96%' } }];
  let value: ReturnType<typeof useSessionTurnOutcome>;
  function Probe() { value = useSessionTurnOutcome('p1', 's1'); return null; }
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  expect(value!).toEqual({ last_ended: undefined, recent_failures: undefined, atMs: undefined });

  await act(async () => {
    client.setQueryData(qk.project.sessionTurn('p1', 's1'), { turns: [], last_ended: lastEnded, recent_failures: recentFailures, atMs: 1 });
    // React Query notifies observers on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(value!).toEqual({ last_ended: lastEnded, recent_failures: recentFailures, atMs: 1 });
  expect(fetchSpy.mock.calls.length).toBe(0);

  await act(async () => root!.unmount());
  client.clear();
});

// The end frame that names a cause is often one frame behind the abort. A read
// taken in that gap lists the turn with no cause; waiting for the next idle poll
// (15 s) would leave the turn silent that long. The hook asks the OWNER for one
// more read once the settle window has passed. It still never fetches itself.
test('asks the poll owner for one more read after an unnamed failure, and never fetches itself', async () => {
  const fetchSpy = mock(async () => Response.json({}));
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = qk.project.sessionTurn('p1', 's2');
  function Probe() { useSessionTurnOutcome('p1', 's2'); return null; }
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });

  const endedAt = new Date().toISOString();
  await act(async () => {
    client.setQueryData(key, {
      turns: [],
      recent_failures: [{ message_id: 'msg_u1', ended_at: endedAt, error: null }],
      atMs: Date.parse(endedAt) + 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TURN_END_SETTLE_MS + 200));
  });
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  expect(fetchSpy.mock.calls.length).toBe(0);

  await act(async () => root!.unmount());
  client.clear();
});

test('does not ask again for a failure that is already settled or already named', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = qk.project.sessionTurn('p1', 's3');
  function Probe() { useSessionTurnOutcome('p1', 's3'); return null; }
  let root: ReturnType<typeof create>;
  await act(async () => {
    root = create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  const long = '2026-09-18T13:42:49.000Z';
  await act(async () => {
    client.setQueryData(key, {
      turns: [],
      recent_failures: [
        { message_id: 'msg_old', ended_at: long, error: null },
        { message_id: 'msg_named', ended_at: new Date().toISOString(), error: { name: 'SandboxMemoryGuard', message: 'x' } },
      ],
      atMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, TURN_END_SETTLE_MS + 200));
  });
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  await act(async () => root!.unmount());
  client.clear();
});

