import { describe, expect, mock, test } from 'bun:test';

// `useQuery` returns its config so the wiring is asserted without a render tree.
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useSessionUsage } = await import('./use-session-usage');
const { qk } = await import('./query-keys');

describe('useSessionUsage', () => {
  test('keys on the session, apart from its model usage record', () => {
    const query = useSessionUsage('p1', 's1') as any;
    expect(query.queryKey).toEqual(qk.project.sessionUsage('p1', 's1'));
    expect(query.queryKey).not.toEqual(qk.project.sessionModelUsage('p1', 's1'));
    expect((useSessionUsage('p1', 's2') as any).queryKey).not.toEqual(query.queryKey);
  });

  test('disabled until both ids are known, or when the caller turns it off', () => {
    expect((useSessionUsage(null, 's1') as any).enabled).toBe(false);
    expect((useSessionUsage('p1', undefined) as any).enabled).toBe(false);
    expect((useSessionUsage('p1', 's1', { enabled: false }) as any).enabled).toBe(false);
    expect((useSessionUsage('p1', 's1') as any).enabled).toBe(true);
  });
});
