import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionTurn } from '../core/rest/projects-client/sessions';
import { qk } from './query-keys';
import { useSessionOpenTurnTokens } from './use-session';
import type { SessionTurnObservation } from './use-session-working';

/**
 * The open turn SET `useSession` hands `useSessionSync`, read from the same
 * `/turn` cache entry `useSessionWorking` fills. `serverOpenTurnToken` names
 * only `turns[0]`, and the ledger's list is not ordered, so a boundary check
 * on it alone would fire on a reorder.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReactTestRenderer | undefined;
let client: QueryClient;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
});

function turn(token: string, state: SessionTurn['state'] = 'active'): SessionTurn {
  return {
    turn_token: token,
    state,
    message_id: `msg_${token}`,
    opencode_session_id: 'ses_wire',
    started_at: '2026-09-17T10:00:00.000Z',
    accepted_at: '2026-09-17T10:00:00.000Z',
  };
}

function observation(turns: SessionTurn[], atMs = 1_000): SessionTurnObservation {
  return { turns, atMs, source: 'read' };
}

async function mount(enabled = true) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const seen: Array<readonly string[] | undefined> = [];
  function Probe() {
    seen.push(useSessionOpenTurnTokens('p1', 's1', enabled));
    return null;
  }
  await act(async () => {
    root = create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  return { seen, latest: () => seen[seen.length - 1] };
}

test('lists every open turn token of the cached /turn read, and follows each new read', async () => {
  const probe = await mount();
  expect(probe.latest()).toBeUndefined();

  await act(async () => {
    client.setQueryData(qk.project.sessionTurn('p1', 's1'), observation([turn('tok_A')]));
  });
  expect(probe.latest()).toEqual(['tok_A']);

  await act(async () => {
    client.setQueryData(
      qk.project.sessionTurn('p1', 's1'),
      observation([turn('tok_B'), turn('tok_C', 'delivering')], 2_000),
    );
  });
  expect(probe.latest()).toEqual(['tok_B', 'tok_C']);

  await act(async () => {
    client.setQueryData(qk.project.sessionTurn('p1', 's1'), observation([], 3_000));
  });
  expect(probe.latest()).toEqual([]);
});

test('a newer read with the same turns keeps the same array', async () => {
  const probe = await mount();
  await act(async () => {
    client.setQueryData(qk.project.sessionTurn('p1', 's1'), observation([turn('tok_A')]));
  });
  const first = probe.latest();

  await act(async () => {
    client.setQueryData(qk.project.sessionTurn('p1', 's1'), observation([turn('tok_A')], 9_000));
  });

  expect(probe.latest()).toBe(first);
});

test('another session\'s /turn read is not this session\'s', async () => {
  const probe = await mount();

  await act(async () => {
    client.setQueryData(qk.project.sessionTurn('p1', 's2'), observation([turn('tok_X')]));
  });

  expect(probe.latest()).toBeUndefined();
});

test('a disabled session reports the set as unknown', async () => {
  const probe = await mount(false);

  await act(async () => {
    client.setQueryData(qk.project.sessionTurn('p1', 's1'), observation([turn('tok_A')]));
  });

  expect(probe.latest()).toBeUndefined();
});
