import { describe, expect, test, mock } from 'bun:test';

// Same harness as `./use-project-triggers.test.ts` — `useQuery` mocked to
// identity so the hook can be called as a plain function and its
// `queryKey`/`enabled` wiring asserted without a render tree.

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
}));

const { useProjectStarterSuggestions } = await import('./use-project-starter-suggestions');
const { qk } = await import('./query-keys');

describe('useProjectStarterSuggestions (query-key stability + enabled gate)', () => {
  test('builds the query key from qk.project.starterSuggestions', () => {
    const result = useProjectStarterSuggestions('proj-1') as any;
    expect(result.queryKey).toEqual(qk.project.starterSuggestions('proj-1'));
  });

  test('is disabled without a projectId, enabled once one is supplied', () => {
    expect((useProjectStarterSuggestions(undefined) as any).enabled).toBe(false);
    expect((useProjectStarterSuggestions(null) as any).enabled).toBe(false);
    expect((useProjectStarterSuggestions('proj-1') as any).enabled).toBe(true);
  });

  test('a different projectId gets its own (non-colliding) query key', () => {
    const a = useProjectStarterSuggestions('proj-a') as any;
    const b = useProjectStarterSuggestions('proj-b') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
  });

  test('uses the config freshness tier (staleTime 60_000, refetchOnMount true)', () => {
    const result = useProjectStarterSuggestions('proj-1') as any;
    expect(result.staleTime).toBe(60_000);
    expect(result.refetchOnMount).toBe(true);
  });
});
