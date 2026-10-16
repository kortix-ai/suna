import { describe, expect, test, beforeEach, mock } from 'bun:test';

// Same harness as `./use-project-secrets.test.ts` — `useQuery`/`useMutation`
// mocked to identity so the hook can be called as a plain function and its
// `queryKey`/`enabled`/`onSuccess` wiring asserted without a render tree.

let invalidated: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useInfiniteQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
  }),
}));

const { useProjectTriggers, projectTriggersKey } = await import('./use-project-triggers');
const { qk } = await import('./query-keys');
const { configureKortix } = await import('../core/http/config');

beforeEach(() => {
  invalidated = [];
});

describe('useProjectTriggers (query-key stability + invalidation wiring)', () => {
  test('builds the query key from projectTriggersKey, which delegates to qk.project.triggers', () => {
    const result = useProjectTriggers('proj-1') as any;
    expect(result.queryKey).toEqual(projectTriggersKey('proj-1'));
    expect(result.queryKey).toEqual(qk.project.triggers('proj-1'));
  });

  test('is disabled without a projectId, enabled once one is supplied', () => {
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

  test('a real fire invalidates the triggers scope, which holds the run lists too', () => {
    const result = useProjectTriggers('proj-1') as any;
    result.fire.onSuccess({ status: 'fired' }, 'nightly');
    result.fire.onSuccess({ status: 'queued' }, { slug: 'nightly', payload: { body: {} } });
    expect(invalidated).toEqual([[...projectTriggersKey('proj-1')], [...projectTriggersKey('proj-1')]]);
  });

  test('dryRun is its own mutation and invalidates nothing: it writes no run', () => {
    const result = useProjectTriggers('proj-1') as any;
    expect(result.dryRun.onSuccess).toBeUndefined();
  });

  test('fire takes a slug or { slug, payload }; dryRun sends dry_run; replay posts the run', async () => {
    const sent: { url: string; body: unknown }[] = [];
    globalThis.fetch = mock(async (url: unknown, opts: { body?: string } = {}) => {
      sent.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : undefined });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

    const result = useProjectTriggers('proj-1') as any;
    await result.fire.mutationFn('nightly');
    await result.fire.mutationFn({ slug: 'tickets', payload: { body: { a: 1 } } });
    await result.dryRun.mutationFn({ slug: 'tickets', payload: { body: { a: 1 } } });
    await result.dryRun.mutationFn('tickets');
    await result.replay.mutationFn({ slug: 'nightly', runId: 'run-1', confirmUnverified: true });
    await result.replay.mutationFn({ slug: 'nightly', runId: 'run-1' });

    expect(sent).toEqual([
      { url: 'http://test.local/projects/proj-1/triggers/nightly/fire', body: {} },
      { url: 'http://test.local/projects/proj-1/triggers/tickets/fire', body: { payload: { body: { a: 1 } } } },
      { url: 'http://test.local/projects/proj-1/triggers/tickets/fire', body: { payload: { body: { a: 1 } }, dry_run: true } },
      { url: 'http://test.local/projects/proj-1/triggers/tickets/fire', body: { dry_run: true } },
      { url: 'http://test.local/projects/proj-1/triggers/nightly/runs/run-1/replay', body: { confirm_unverified: true } },
      { url: 'http://test.local/projects/proj-1/triggers/nightly/runs/run-1/replay', body: {} },
    ]);
  });

  test('replay invalidates the triggers scope on success', () => {
    const result = useProjectTriggers('proj-1') as any;
    result.replay.onSuccess();
    expect(invalidated).toEqual([[...projectTriggersKey('proj-1')]]);
  });

  test('a different projectId gets its own (non-colliding) query key', () => {
    const a = useProjectTriggers('proj-a') as any;
    const b = useProjectTriggers('proj-b') as any;
    expect(a.queryKey).not.toEqual(b.queryKey);
  });
});

describe('useProjectTriggerEventTypes', () => {
  test('keys on the connector and is enabled only when project and connector are set', async () => {
    const { useProjectTriggerEventTypes, projectTriggerEventTypesKey } = await import('./use-project-triggers');
    const on = useProjectTriggerEventTypes('proj-1', 'github') as any;
    expect(on.queryKey).toEqual(projectTriggerEventTypesKey('proj-1', 'github'));
    expect(on.queryKey).toEqual(qk.project.triggerEventTypes('proj-1', 'github'));
    expect(on.enabled).toBe(true);
    expect((useProjectTriggerEventTypes('proj-1', null) as any).enabled).toBe(false);
    expect((useProjectTriggerEventTypes(undefined, 'github') as any).enabled).toBe(false);
  });

  test('an { app, source } target keys apart from any connector slug and is enabled without a connector', async () => {
    const { useProjectTriggerEventTypes, projectTriggerEventTypesKey } = await import('./use-project-triggers');
    const byApp = useProjectTriggerEventTypes('proj-1', { app: 'github' }) as any;
    expect(byApp.enabled).toBe(true);
    expect(byApp.queryKey).toEqual(projectTriggerEventTypesKey('proj-1', { app: 'github' }));
    expect(byApp.queryKey).not.toEqual(projectTriggerEventTypesKey('proj-1', 'github'));
    expect(projectTriggerEventTypesKey('proj-1', { app: 'github', source: 'composio' })).toEqual(
      projectTriggerEventTypesKey('proj-1', { app: 'github' }),
    );
    expect((useProjectTriggerEventTypes('proj-1', { app: '' }) as any).enabled).toBe(false);
  });
});

describe('useProjectTriggerEventApps', () => {
  test('keys per project and is enabled only with a project', async () => {
    const { useProjectTriggerEventApps, projectTriggerEventAppsKey } = await import('./use-project-triggers');
    const on = useProjectTriggerEventApps('proj-1') as any;
    expect(on.queryKey).toEqual(projectTriggerEventAppsKey('proj-1'));
    expect(on.queryKey).toEqual(qk.project.triggerEventApps('proj-1'));
    expect(on.enabled).toBe(true);
    expect((useProjectTriggerEventApps(undefined) as any).enabled).toBe(false);
  });
});

describe('useTriggerRuns / useProjectTriggerRuns (cursor-paged run history)', () => {
  test('useTriggerRuns keys under the triggers scope per slug and pages by next_cursor', async () => {
    const { useTriggerRuns, triggerRunsKey } = await import('./use-project-triggers');
    const q = useTriggerRuns('proj-1', 'nightly') as any;
    expect(q.queryKey).toEqual(triggerRunsKey('proj-1', 'nightly'));
    expect(q.queryKey).toEqual(qk.project.triggerRuns('proj-1', 'nightly'));
    expect(q.queryKey.slice(0, qk.project.triggers('proj-1').length)).toEqual([...qk.project.triggers('proj-1')]);
    expect(q.initialPageParam).toBeUndefined();
    expect(q.getNextPageParam({ runs: [], next_cursor: 'c2' })).toBe('c2');
    expect(q.getNextPageParam({ runs: [], next_cursor: null })).toBeUndefined();
    expect(q.enabled).toBe(true);
    expect((useTriggerRuns('proj-1', null) as any).enabled).toBe(false);
    expect((useTriggerRuns(undefined, 'nightly') as any).enabled).toBe(false);
  });

  test('useProjectTriggerRuns keys per status filter under the triggers scope', async () => {
    const { useProjectTriggerRuns, projectTriggerRunsKey } = await import('./use-project-triggers');
    const all = useProjectTriggerRuns('proj-1') as any;
    const failed = useProjectTriggerRuns('proj-1', { status: 'failed' }) as any;
    expect(all.queryKey).toEqual(projectTriggerRunsKey('proj-1'));
    expect(failed.queryKey).toEqual(projectTriggerRunsKey('proj-1', 'failed'));
    expect(failed.queryKey).toEqual(qk.project.projectTriggerRuns('proj-1', 'failed'));
    expect(all.queryKey).not.toEqual(failed.queryKey);
    expect(failed.queryKey.slice(0, qk.project.triggers('proj-1').length)).toEqual([...qk.project.triggers('proj-1')]);
    expect(failed.getNextPageParam({ runs: [], next_cursor: 'c9' })).toBe('c9');
    expect((useProjectTriggerRuns(null) as any).enabled).toBe(false);
  });

  test('a per-trigger run key never collides with the project run key', async () => {
    const { triggerRunsKey, projectTriggerRunsKey } = await import('./use-project-triggers');
    expect(triggerRunsKey('proj-1', 'failed')).not.toEqual(projectTriggerRunsKey('proj-1', 'failed'));
  });
});

describe('run hooks take { enabled, refetchInterval } (useReviewItems pattern)', () => {
  test('defaults: enabled with ids, no polling', async () => {
    const { useTriggerRuns, useProjectTriggerRuns } = await import('./use-project-triggers');
    expect((useTriggerRuns('proj-1', 'nightly') as any).refetchInterval).toBe(false);
    expect((useProjectTriggerRuns('proj-1') as any).refetchInterval).toBe(false);
  });

  test('enabled: false idles the query; refetchInterval polls', async () => {
    const { useTriggerRuns, useProjectTriggerRuns } = await import('./use-project-triggers');
    const off = useTriggerRuns('proj-1', 'nightly', { enabled: false }) as any;
    const poll = useTriggerRuns('proj-1', 'nightly', { refetchInterval: 3_000 }) as any;
    expect(off.enabled).toBe(false);
    expect(poll.enabled).toBe(true);
    expect(poll.refetchInterval).toBe(3_000);
    const pOff = useProjectTriggerRuns('proj-1', { status: 'failed' }, { enabled: false }) as any;
    const pPoll = useProjectTriggerRuns('proj-1', undefined, { refetchInterval: 3_000 }) as any;
    expect(pOff.enabled).toBe(false);
    expect(pPoll.refetchInterval).toBe(3_000);
    // enabled: true never overrides a missing id.
    expect((useTriggerRuns('proj-1', null, { enabled: true }) as any).enabled).toBe(false);
  });
});
