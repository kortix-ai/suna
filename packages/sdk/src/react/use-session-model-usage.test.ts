import { describe, expect, mock, test } from 'bun:test';

// `useQuery` returns its config so the wiring is asserted without a render tree.
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useSessionModelUsage } = await import('./use-session-model-usage');
const { qk } = await import('./query-keys');

describe('useSessionModelUsage', () => {
  test('keys on the session alone, so every reader shares one record', () => {
    const query = useSessionModelUsage('p1', 's1') as any;
    expect(query.queryKey).toEqual(qk.project.sessionModelUsage('p1', 's1'));
    expect((useSessionModelUsage('p1', 's2') as any).queryKey).not.toEqual(query.queryKey);
    expect((useSessionModelUsage('p2', 's1') as any).queryKey).not.toEqual(query.queryKey);
  });

  test('disabled until both ids are known', () => {
    expect((useSessionModelUsage(null, 's1') as any).enabled).toBe(false);
    expect((useSessionModelUsage('p1', undefined) as any).enabled).toBe(false);
    expect((useSessionModelUsage('p1', 's1') as any).enabled).toBe(true);
  });
});
