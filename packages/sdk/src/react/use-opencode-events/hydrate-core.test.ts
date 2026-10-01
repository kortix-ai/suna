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
    client: client as unknown as Parameters<typeof hydrateCore>[0]['client'],
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

test('gap hydration reconciles every loaded transcript, including idle sessions, and releases failed reads', async () => {
  useSyncStore.getState().reset();
  useSyncStore.setState({ messages: { gap_idle_a: [], gap_idle_b: [] } });
  const calls: string[] = [];
  let rejectTail!: (reason: Error) => void;
  const tail = new Promise<void>((_, reject) => { rejectTail = reject; });
  const client = {
    permission: { list: async () => ({ data: [] }) },
    question: { list: async () => ({ data: [] }) },
    session: { status: async () => ({ data: {} }) },
  };
  const deps = {
    client: client as unknown as Parameters<typeof hydrateCore>[0]['client'],
    queryClient: new QueryClient(),
    addPermission: () => {}, addQuestion: () => {},
    applySyncEvent: (event: Parameters<ReturnType<typeof useSyncStore.getState>['applyEvent']>[0]) => useSyncStore.getState().applyEvent(event),
    reconcileMissingBusySessions: { current: () => {} },
    fetchLspDiagnosticsDebounced: { current: () => {} },
    reconcileSessionTail: async (id: string) => { calls.push(id); await tail; },
    options: { rehydrateMessages: true },
  };
  hydrateCore(deps);
  hydrateCore(deps);
  expect(calls).toEqual(['gap_idle_a', 'gap_idle_b']);
  rejectTail(new Error('offline'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  hydrateCore(deps);
  expect(calls).toEqual(['gap_idle_a', 'gap_idle_b']);
});

test('failed snapshot reads do not prevent independent hydration or diagnostics', async () => {
  useSyncStore.getState().reset();
  const failure = new Error('offline');
  const questions: unknown[] = [];
  let diagnostics = 0;
  hydrateCore({
    client: {
      permission: { list: async () => { throw failure; } },
      question: { list: async () => ({ data: [{ id: 'q' }] }) },
      session: { status: async () => { throw failure; } },
    } as unknown as Parameters<typeof hydrateCore>[0]['client'],
    queryClient: new QueryClient(),
    addPermission: () => {}, addQuestion: (question) => { questions.push(question); },
    applySyncEvent: (event) => useSyncStore.getState().applyEvent(event),
    reconcileMissingBusySessions: { current: () => {} },
    fetchLspDiagnosticsDebounced: { current: () => { diagnostics++; } },
    reconcileSessionTail: async () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(questions).toEqual([{ id: 'q' }]);
  expect(diagnostics).toBe(1);
});
