import { describe, expect, test, beforeEach, mock } from 'bun:test';

// react-query's `useQuery`/`useMutation` are mocked down to identity functions
// (return the config object passed in) so the hook under test can be called
// as a plain function — no React render tree needed — while still exercising
// the exact `queryKey`/`enabled`/`onSuccess` values the real hook builds.
// Same harness as `./use-kortix-master.test.ts`. This intentionally never
// calls `queryFn`/`mutationFn` — those go through `backendApi`, which needs a
// configured platform seam; this test only asserts the queryKey/invalidation
// WIRING, not the network calls (covered at the facade level in
// `../kortix.test.ts`).

let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
  }),
}));

const { useProjectSecrets, projectSecretsKey } = await import('./use-project-secrets');

beforeEach(() => {
  invalidated = [];
});

describe('useProjectSecrets (query-key stability + invalidation wiring)', () => {
  test('builds the query key from projectSecretsKey', () => {
    const result = useProjectSecrets('proj-1') as any;
    expect(result.queryKey).toEqual(projectSecretsKey('proj-1'));
    expect(result.queryKey).toEqual(['project-secrets', 'proj-1']);
  });

  test('is disabled without a projectId, enabled once one is supplied', () => {
    expect((useProjectSecrets(undefined) as any).enabled).toBe(false);
    expect((useProjectSecrets(null) as any).enabled).toBe(false);
    expect((useProjectSecrets('proj-1') as any).enabled).toBe(true);
  });

  test('upsert/remove/setPersonal/removePersonal all invalidate the same list key on success', () => {
    const result = useProjectSecrets('proj-1') as any;
    const expectedKey = [...projectSecretsKey('proj-1')];

    result.upsert.onSuccess();
    result.remove.onSuccess();
    result.setPersonal.onSuccess();
    result.removePersonal.onSuccess();

    expect(invalidated).toEqual([expectedKey, expectedKey, expectedKey, expectedKey]);
  });

  test('a different projectId gets its own (non-colliding) query key', () => {
    const a = useProjectSecrets('proj-a') as any;
    const b = useProjectSecrets('proj-b') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
  });
});
