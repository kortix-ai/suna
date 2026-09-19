import { afterAll, afterEach, expect, mock, test } from 'bun:test';

import * as projectsClientModule from '../core/rest/projects-client';
import * as openBundleModule from '../core/session/open-bundle';
import * as sessionSyncModule from './use-session-sync';

// Copies taken before `mock.module`: the namespace objects are live bindings
// and would resolve to the mocks afterwards.
const realProjectsClient = { ...projectsClientModule };
const realOpenBundle = { ...openBundleModule };
const realSessionSync = { ...sessionSyncModule };

type SyncOptions = Parameters<typeof realSessionSync.useSessionSync>[1];
const syncCalls: Array<{ sessionId: string; options: SyncOptions }> = [];

// The /start poll and the open bundle never answer: the session stays
// unswitched, and no request leaves the test.
mock.module('../core/rest/projects-client', () => ({
  ...realProjectsClient,
  startProjectSession: () => new Promise(() => {}),
}));
mock.module('../core/session/open-bundle', () => ({
  ...realOpenBundle,
  openSessionBundle: () => {},
}));
mock.module('./use-session-sync', () => ({
  ...realSessionSync,
  useSessionSync: (...args: Parameters<typeof realSessionSync.useSessionSync>) => {
    syncCalls.push({ sessionId: args[0], options: args[1] });
    return realSessionSync.useSessionSync(...args);
  },
}));

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionTurn } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';
import { useSession } from './use-session';
import type { SessionTurnObservation } from './use-session-working';

/**
 * `useSession` owns the /turn observation and `useSessionSync` owns the turn
 * boundary read. `openTurnTokens` is optional, so a `useSession` that stops
 * passing it still compiles, and the boundary read never fires. This test pins
 * the hand-over; `use-session-sync.test.ts` pins the read itself.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error('no network in this test');
}) as unknown as typeof fetch;

let root: ReactTestRenderer | undefined;
let client: QueryClient | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  syncCalls.length = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function turn(token: string): SessionTurn {
  return {
    turn_token: token,
    state: 'active',
    message_id: `msg_${token}`,
    opencode_session_id: 'ses_wire',
    started_at: '2026-09-17T10:00:00.000Z',
    accepted_at: '2026-09-17T10:00:00.000Z',
  };
}

function observation(tokens: string[]): SessionTurnObservation {
  return { turns: tokens.map(turn), atMs: Date.now(), source: 'read' };
}

test('useSession hands useSessionSync every open turn token of the /turn read, and each new set', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client = queryClient;
  queryClient.setQueryData(qk.project.sessionTurn('p1', 's1'), observation(['tok_A']));
  function Probe() {
    useSession('p1', 's1', { replayStartStash: false });
    return null;
  }

  await act(async () => {
    root = create(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  expect(syncCalls.length).toBeGreaterThan(0);
  expect(syncCalls[syncCalls.length - 1].options?.openTurnTokens).toEqual(['tok_A']);

  await act(async () => {
    queryClient.setQueryData(qk.project.sessionTurn('p1', 's1'), observation(['tok_B', 'tok_C']));
  });

  expect(syncCalls[syncCalls.length - 1].options?.openTurnTokens).toEqual(['tok_B', 'tok_C']);
});
