import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-project-secrets.test.ts` — `useQuery`/`useMutation`
// mocked to identity so the hook can be called as a plain function and its
// `queryKey`/`enabled`/`onSuccess` wiring asserted without a render tree.

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

const { useProjectTriggers, projectTriggersKey } = await import('./use-project-triggers');
const { qk } = await import('./query-keys');

beforeEach(() => {
  invalidated = [];
});

describe('useProjectTriggers (query-key stability + invalidation wiring)', () => {
  test('builds the query key from projectTriggersKey, which delegates to qk.project.triggers', () => {
    const result = useProjectTriggers('proj-1') as any;
    expect(result.queryKey).toEqual(projectTriggersKey('proj-1'));
    expect(result.queryKey).toEqual(qk.project.triggers('proj-1'));
  });

  test('is disabled without a workspaceId, enabled once one is supplied', () => {
    expect((useProjectTriggers(undefined) as any).enabled).toBe(false);
    expect((useProjectTriggers(null) as any).enabled).toBe(false);
    expect((useProjectTriggers('proj-1') as any).enabled).toBe(true);
  });

  test('create/update/remove all invalidate the same listing key on success', () => {
    const result = useProjectTriggers('proj-1') as any;
    const expectedKey = [...projectTriggersKey('proj-1')];

    result.create.onSuccess();
    result.update.onSuccess();
    result.remove.onSuccess();

    expect(invalidated).toEqual([expectedKey, expectedKey, expectedKey]);
  });

  test('firing a trigger does not invalidate the listing', () => {
    const result = useProjectTriggers('proj-1') as any;
    expect(result.fire.onSuccess).toBeUndefined();
  });

  test('a different workspaceId gets its own (non-colliding) query key', () => {
    const a = useProjectTriggers('proj-a') as any;
    const b = useProjectTriggers('proj-b') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
  });
});
