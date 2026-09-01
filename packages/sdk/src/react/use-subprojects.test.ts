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
  useSubprojects,
  useProjectSubprojects,
  useSubprojectRuns,
  useProjectSubprojectRuns,
  subprojectsKey,
  projectSubprojectsKey,
  subprojectRunsKey,
} = await import('./use-subprojects');
const { qk } = await import('./query-keys');

beforeEach(() => {
  invalidated = [];
});

describe('useSubprojects — the store listing', () => {
  test('keys on the search options, so two searches are two cache entries', () => {
    const a = useSubprojects({ q: 'seo' }) as any;
    const b = useSubprojects({ q: 'standup' }) as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey).toEqual(subprojectsKey({ q: 'seo' }));
  });

  test('an absent option and an explicit undefined produce the SAME key', () => {
    // Otherwise the first render and the first "clear the search" render would
    // read two different cache entries and the list would flicker.
    expect(subprojectsKey()).toEqual(subprojectsKey({ q: undefined }));
  });

  test('is always enabled — the store needs no project', () => {
    expect((useSubprojects() as any).enabled).not.toBe(false);
  });
});

describe('useProjectSubprojects — what is installed here', () => {
  test('keys on the project and delegates to qk', () => {
    const r = useProjectSubprojects('p1') as any;
    expect(r.queryKey).toEqual(projectSubprojectsKey('p1'));
    expect(r.queryKey).toEqual(qk.project.subprojects('p1'));
  });

  test('is disabled without a projectId', () => {
    expect((useProjectSubprojects(undefined) as any).enabled).toBe(false);
    expect((useProjectSubprojects(null) as any).enabled).toBe(false);
    expect((useProjectSubprojects('p1') as any).enabled).toBe(true);
  });

  test('install invalidates BOTH the installed list and the store', () => {
    // The store card shows an install count and an installed pill, so leaving
    // it stale would show "Install" on a subproject that was just installed.
    const r = useProjectSubprojects('p1') as any;
    r.install.onSuccess();
    expect(invalidated).toContainEqual([...projectSubprojectsKey('p1')]);
    expect(invalidated.some((k) => k[0] === 'kx' && k[1] === 'subprojects')).toBe(true);
  });

  test('uninstall invalidates the installed list and the runs scope', () => {
    // Removing a subproject removes its runs from the report; a stale runs list
    // would keep showing history for something no longer installed.
    const r = useProjectSubprojects('p1') as any;
    r.uninstall.onSuccess();
    expect(invalidated).toContainEqual([...projectSubprojectsKey('p1')]);
    expect(invalidated).toContainEqual([...qk.project.subprojectRunsScope('p1')]);
  });
});

describe('useSubprojectRuns — one subproject', () => {
  test('keys on project AND slug', () => {
    const a = useSubprojectRuns('p1', 'seo') as any;
    const b = useSubprojectRuns('p1', 'standup') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
    expect(a.queryKey).toEqual(subprojectRunsKey('p1', 'seo'));
  });

  test('is disabled without either a project or a slug', () => {
    expect((useSubprojectRuns(undefined, 'seo') as any).enabled).toBe(false);
    expect((useSubprojectRuns('p1', undefined) as any).enabled).toBe(false);
    expect((useSubprojectRuns('p1', 'seo') as any).enabled).toBe(true);
  });

  test('sits under the project runs SCOPE so one invalidation reaches every subproject', () => {
    const scope = qk.project.subprojectRunsScope('p1');
    const key = subprojectRunsKey('p1', 'seo') as readonly unknown[];
    expect(key.slice(0, scope.length)).toEqual([...scope]);
  });
});

describe('useProjectSubprojectRuns — every subproject', () => {
  test('keys under the same runs scope as a single subproject', () => {
    const scope = qk.project.subprojectRunsScope('p1');
    const key = (useProjectSubprojectRuns('p1') as any).queryKey as readonly unknown[];
    expect(key.slice(0, scope.length)).toEqual([...scope]);
  });

  test('is distinct from any single subproject key', () => {
    const all = (useProjectSubprojectRuns('p1') as any).queryKey;
    expect(all).not.toEqual(subprojectRunsKey('p1', 'seo'));
  });

  test('is disabled without a projectId', () => {
    expect((useProjectSubprojectRuns(null) as any).enabled).toBe(false);
  });
});
