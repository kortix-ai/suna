import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { useSyncStore } from '../../browser/stores/sync-store';
import { hydrateCore } from './hydrate-core';

test('hydration launches independent reads and leaves a newer wire status intact', async () => {
  useSyncStore.getState().reset();
  let resolveStatus!: (value: { data: Record<string, { type: string }> }) => void;
  const status = new Promise<{ data: Record<string, { type: string }> }>((resolve) => {
    resolveStatus = resolve;
  });
  const calls: string[] = [];
  const client = {
    permission: {
      list: async () => {
        calls.push('permissions');
        return { data: [{ id: 'p' }] };
      },
    },
    question: {
      list: async () => {
        calls.push('questions');
        return { data: [{ id: 'q' }] };
      },
    },
    session: {
      status: () => {
        calls.push('status');
        return status;
      },
    },
  };
  const permissions: unknown[] = [];
  const questions: unknown[] = [];
  const missing: unknown[] = [];
  const diagnostics: unknown[] = [];
  const queryClient = new QueryClient();
  hydrateCore({
    reconcileSessionTail: async () => {},
    client: client as Parameters<typeof hydrateCore>[0]['client'],
    queryClient,
    addPermission: (p) => {
      permissions.push(p);
    },
    addQuestion: (q) => {
      questions.push(q);
    },
    applySyncEvent: (event) => useSyncStore.getState().applyEvent(event),
    reconcileMissingBusySessions: {
      current: (s) => {
        missing.push(s);
      },
    },
    fetchLspDiagnosticsDebounced: {
      current: () => {
        diagnostics.push(true);
      },
    },
  });
  expect(calls).toEqual(['permissions', 'questions', 'status']);
  expect(diagnostics).toHaveLength(1);
  useSyncStore
    .getState()
    .applyEvent({
      type: 'session.status',
      properties: { sessionID: 's', status: { type: 'idle' } },
    } as never);
  resolveStatus({ data: { s: { type: 'busy' }, other: { type: 'busy' } } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(permissions).toHaveLength(1);
  expect(questions).toHaveLength(1);
  expect(useSyncStore.getState().sessionStatus.s).toEqual({ type: 'idle' });
  expect(useSyncStore.getState().sessionStatus.other).toEqual({ type: 'busy' });
  expect(missing).toEqual([{ s: { type: 'busy' }, other: { type: 'busy' } }]);
});
