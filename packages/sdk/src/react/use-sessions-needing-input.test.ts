import { describe, expect, mock, test } from 'bun:test';

// `useQuery` is mocked to record the hook's config, and
// `listSessionsNeedingInput` is mocked so the recorded `queryFn` can run here
// (the harness of `./use-project-session.test.ts`).
const needsInputCalls: unknown[][] = [];
const queryConfigs: { queryFn: () => Promise<unknown> }[] = [];
mock.module('../core/rest/projects-client', () => ({
  listSessionsNeedingInput: (...args: unknown[]) => {
    needsInputCalls.push(args);
    return Promise.resolve({ total: 0, sessions: {} });
  },
}));
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: { queryFn: () => Promise<unknown> }) => {
    queryConfigs.push(config);
    return config;
  },
}));

const { qk } = await import('./query-keys');
const { sessionNeedsInputCount, useSessionsNeedingInput } = await import(
  './use-sessions-needing-input'
);

describe('sessionNeedsInputCount', () => {
  const summary = { total: 3, sessions: { 'kx-1': 2, 'oc-2': 1 } };

  test('reads the count by session id', () => {
    expect(sessionNeedsInputCount(summary, { session_id: 'kx-1' })).toBe(2);
  });

  test('falls back to the runtime session id', () => {
    expect(sessionNeedsInputCount(summary, { session_id: 'kx-9', runtime_session_id: 'oc-2' })).toBe(1);
  });

  test('is 0 for a session nothing waits on, and for no summary', () => {
    expect(sessionNeedsInputCount(summary, { session_id: 'kx-9' })).toBe(0);
    expect(sessionNeedsInputCount(undefined, { session_id: 'kx-1' })).toBe(0);
  });
});

describe('qk.project.needsInput', () => {
  test('nests under the project scope so a project invalidation reaches it', () => {
    const scope = qk.project.scope('P1');
    expect(qk.project.needsInput('P1').slice(0, scope.length)).toEqual([...scope]);
  });
});

describe('useSessionsNeedingInput', () => {
  // The badge poll runs every 30 s in every open tab; nobody asked for it. A
  // failed read must not reach the host's `onError` (a toast + a frontend
  // Sentry capture per poll): the API already captures its own 500. During the
  // 2026-11-06 rollout window this poll was 92 of the 96 frontend
  // `ApiError: Internal server error` events (KRTX-4358).
  test('polls with showErrors: false', async () => {
    useSessionsNeedingInput('P1');
    expect(queryConfigs).toHaveLength(1);
    await queryConfigs[0]?.queryFn();
    expect(needsInputCalls).toEqual([['P1', { showErrors: false }]]);
  });
});
