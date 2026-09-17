import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureKortix } from '../core/http/config';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { useSessionPrompts, type UseSessionPromptsResult } from './use-session-prompts';
import { useSessionWorking, type SessionTurnObservation } from './use-session-working';
import type { WorkingProjection } from '../core/session/working';
import { qk } from './query-keys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: ReactTestRenderer | undefined;
let client: QueryClient;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  useSessionWorkingStore.getState().reset();
  globalThis.fetch = originalFetch;
});

function setup() {
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useSessionWorkingStore.getState().reset();
}

test('Quick Queue remains visible while a pending poll is cancelled and POST waits', async () => {
  setup();
  const key = qk.project.sessionPrompts('p1', 's1');
  client.setQueryData(key, []);
  // Neither request resolves: the local acceptance state must not need either answer.
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  let queue: UseSessionPromptsResult;
  function Probe() { queue = useSessionPrompts('p1', 's1'); return null; }
  await act(async () => { root = create(createElement(QueryClientProvider, { client }, createElement(Probe))); });
  await act(async () => { void queue!.refetch(); });
  expect(client.getQueryState(key)?.fetchStatus).toBe('fetching');
  await act(async () => {
    void queue!.enqueue({ placement: 'transcript', clientMessageId: 'c1', messageId: 'm1', parts: [{ type: 'text', text: 'first' }] });
    await Bun.sleep(10);
  });
  expect(queue!.prompts.map((prompt) => prompt.text)).toEqual(['first']);
});

test('the same turn changes from sending to running on its first active observation', async () => {
  setup();
  const key = qk.project.sessionTurn('p1', 's1');
  const atMs = Date.now();
  const observation: SessionTurnObservation = {
    atMs,
    turns: [{ turn_token: 't1', message_id: 'm1', opencode_session_id: 'wire1', state: 'delivering', started_at: new Date(atMs).toISOString(), accepted_at: new Date(atMs).toISOString() }],
  };
  client.setQueryData(key, observation);
  let working: WorkingProjection;
  function Probe() { working = useSessionWorking('p1', 's1'); return null; }
  await act(async () => { root = create(createElement(QueryClientProvider, { client }, createElement(Probe))); });
  expect(working!.pendingDelivery).toBe(true);
  await act(async () => {
    client.setQueryData(key, { ...observation, turns: observation.turns.map((turn) => ({ ...turn, state: 'active' })) });
    await Bun.sleep(10);
  });
  expect(working!.state).toBe('working');
  expect(working!.pendingDelivery).toBeUndefined();
});
