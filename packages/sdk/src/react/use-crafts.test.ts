import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-triggers.test.ts` — `useQuery`/`useMutation`
// mocked to identity so each hook can be called as a plain function and its
// `queryKey` / `enabled` / `onSuccess` wiring asserted without a render tree.

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

const {
  useCrafts,
  useProjectCrafts,
  useCraftRuns,
  useProjectCraftRuns,
  craftsKey,
  projectCraftsKey,
  craftRunsKey,
} = await import('./use-crafts');
const { qk } = await import('./query-keys');

beforeEach(() => {
  invalidated = [];
});

describe('useCrafts — the store listing', () => {
  test('keys on the search options, so two searches are two cache entries', () => {
    const a = useCrafts({ q: 'seo' }) as any;
    const b = useCrafts({ q: 'standup' }) as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey).toEqual(craftsKey({ q: 'seo' }));
  });

  test('an absent option and an explicit undefined produce the SAME key', () => {
    // Otherwise the first render and the first "clear the search" render would
    // read two different cache entries and the list would flicker.
    expect(craftsKey()).toEqual(craftsKey({ q: undefined }));
  });

  test('is always enabled — the store needs no project', () => {
    expect((useCrafts() as any).enabled).not.toBe(false);
  });
});

describe('useProjectCrafts — what is installed here', () => {
  test('keys on the project and delegates to qk', () => {
    const r = useProjectCrafts('p1') as any;
    expect(r.queryKey).toEqual(projectCraftsKey('p1'));
    expect(r.queryKey).toEqual(qk.project.crafts('p1'));
  });

  test('is disabled without a projectId', () => {
    expect((useProjectCrafts(undefined) as any).enabled).toBe(false);
    expect((useProjectCrafts(null) as any).enabled).toBe(false);
    expect((useProjectCrafts('p1') as any).enabled).toBe(true);
  });

  test('install invalidates BOTH the installed list and the store', () => {
    // The store card shows an install count and an installed pill, so leaving
    // it stale would show "Install" on a craft that was just installed.
    const r = useProjectCrafts('p1') as any;
    r.install.onSuccess();
    expect(invalidated).toContainEqual([...projectCraftsKey('p1')]);
    expect(invalidated.some((k) => k[0] === 'kx' && k[1] === 'crafts')).toBe(true);
  });

  test('uninstall invalidates the installed list and the runs scope', () => {
    // Removing a craft removes its runs from the report; a stale runs list
    // would keep showing history for something no longer installed.
    const r = useProjectCrafts('p1') as any;
    r.uninstall.onSuccess();
    expect(invalidated).toContainEqual([...projectCraftsKey('p1')]);
    expect(invalidated).toContainEqual([...qk.project.craftRunsScope('p1')]);
  });
});

describe('useCraftRuns — one craft', () => {
  test('keys on project AND slug', () => {
    const a = useCraftRuns('p1', 'seo') as any;
    const b = useCraftRuns('p1', 'standup') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey).toEqual(craftRunsKey('p1', 'seo'));
  });

  test('is disabled without either a project or a slug', () => {
    expect((useCraftRuns(undefined, 'seo') as any).enabled).toBe(false);
    expect((useCraftRuns('p1', undefined) as any).enabled).toBe(false);
    expect((useCraftRuns('p1', 'seo') as any).enabled).toBe(true);
  });

  test('sits under the project runs SCOPE so one invalidation reaches every craft', () => {
    const scope = qk.project.craftRunsScope('p1');
    const key = craftRunsKey('p1', 'seo') as readonly unknown[];
    expect(key.slice(0, scope.length)).toEqual([...scope]);
  });
});

describe('useProjectCraftRuns — every craft', () => {
  test('keys under the same runs scope as a single craft', () => {
    const scope = qk.project.craftRunsScope('p1');
    const key = (useProjectCraftRuns('p1') as any).queryKey as readonly unknown[];
    expect(key.slice(0, scope.length)).toEqual([...scope]);
  });

  test('is distinct from any single craft key', () => {
    const all = (useProjectCraftRuns('p1') as any).queryKey;
    expect(all).not.toEqual(craftRunsKey('p1', 'seo'));
  });

  test('is disabled without a projectId', () => {
    expect((useProjectCraftRuns(null) as any).enabled).toBe(false);
  });
});
