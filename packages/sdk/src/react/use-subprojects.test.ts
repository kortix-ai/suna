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

const { useSubprojects, useProjectSubprojects, subprojectsKey, projectSubprojectsKey } =
  await import('./use-subprojects');
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

  test('uninstall invalidates the installed list, and nothing else', () => {
    // One key, deliberately. Uninstall starts a SESSION whose change request
    // removes the manifest entries — the triggers page is not stale when this
    // resolves, because nothing has been removed yet.
    const r = useProjectSubprojects('p1') as any;
    r.uninstall.onSuccess();
    expect(invalidated).toEqual([[...projectSubprojectsKey('p1')]]);
  });

  test('exposes no activation mutation', () => {
    // A subproject is a set of manifest entries, not a running thing. Its
    // triggers are enabled one at a time on the Triggers page, which is the one
    // place a person can see what each trigger does.
    const r = useProjectSubprojects('p1') as any;
    expect(r.setActivation).toBeUndefined();
    expect(Object.keys(r)).toContain('uninstall');
  });
});
