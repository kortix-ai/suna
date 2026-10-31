import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-rooms.test.ts`: `useQuery`/`useMutation` return their
// config so the wiring can be asserted without a render tree.
let invalidated: unknown[][] = [];
let cache = new Map<string, unknown>();
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useInfiniteQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  keepPreviousData: (data: unknown) => data,
  focusManager: { isFocused: () => true },
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
    setQueryData: (key: unknown[], update: (old: unknown) => unknown) => {
      cache.set(JSON.stringify(key), update(cache.get(JSON.stringify(key))));
    },
    setQueriesData: (filters: { queryKey: unknown[] }, update: (old: unknown) => unknown) => {
      const prefix = JSON.stringify(filters.queryKey).slice(0, -1);
      for (const [key, value] of cache) if (key.startsWith(prefix)) cache.set(key, update(value));
    },
  }),
}));

const { useReachableAgents, usePeerMessages, useTeamTasks, useSessionWorkflows, useTeammates } = await import(
  './use-multi-agent'
);
const { qk } = await import('./query-keys');

beforeEach(() => {
  invalidated = [];
  cache = new Map();
});

const interval = (hook: any, data?: unknown) =>
  typeof hook.refetchInterval === 'function' ? hook.refetchInterval({ state: { data } }) : hook.refetchInterval;

describe('multi-agent hooks', () => {
  test('every key nests under the session agents key, so one invalidation refreshes them all', () => {
    const root = qk.project.sessionAgents('p1', 's1');
    for (const key of [
      (useReachableAgents('p1', 's1') as any).queryKey,
      (usePeerMessages('p1', 's1', 'in') as any).queryKey,
      (useTeamTasks('p1', 's1') as any).queryKey,
      (useSessionWorkflows('p1', 's1') as any).queryKey,
      (useTeammates('p1', 's1') as any).queryKey,
    ]) {
      expect(key.slice(0, root.length)).toEqual([...root]);
    }
    // ...and under the session detail key, which every session invalidation hits.
    expect(root.slice(0, qk.project.session('p1', 's1').length)).toEqual([...qk.project.session('p1', 's1')]);
  });

  test('scope and direction key their own cache slots', () => {
    expect((useReachableAgents('p1', 's1') as any).queryKey).toEqual([...qk.project.sessionReachable('p1', 's1', 'mine')]);
    expect((useReachableAgents('p1', 's1', 'project') as any).queryKey).toEqual([
      ...qk.project.sessionReachable('p1', 's1', 'project'),
    ]);
    expect((usePeerMessages('p1', 's1') as any).queryKey).toEqual([...qk.project.peerMessages('p1', 's1', 'all')]);
  });

  test('disabled until both ids are known', () => {
    for (const hook of [useReachableAgents, usePeerMessages, useTeamTasks, useSessionWorkflows, useTeammates] as any[]) {
      expect(hook(null, 's1').enabled).toBe(false);
      expect(hook('p1', undefined).enabled).toBe(false);
      expect(hook('p1', 's1').enabled).toBe(true);
    }
  });

  test('a caller can turn a read off', () => {
    expect((useTeamTasks('p1', 's1', { enabled: false }) as any).enabled).toBe(false);
    expect((useTeammates('p1', 's1', { enabled: false }) as any).enabled).toBe(false);
  });

  test('every read polls at most every 5 s while the page is visible', () => {
    for (const hook of [
      useReachableAgents('p1', 's1'),
      usePeerMessages('p1', 's1', 'in'),
      useTeamTasks('p1', 's1'),
      useSessionWorkflows('p1', 's1'),
      useTeammates('p1', 's1'),
    ] as any[]) {
      expect(interval(hook)).toBeLessThanOrEqual(5_000);
      expect(interval(hook)).toBeGreaterThan(0);
      expect(hook.refetchIntervalInBackground).toBe(false);
    }
  });

  test('workflow runs poll faster while one runs', () => {
    const hook = useSessionWorkflows('p1', 's1') as any;
    expect(interval(hook, [{ status: 'running' }])).toBe(2_000);
    expect(interval(hook, [{ status: 'done' }])).toBe(5_000);
  });

  test('approve and deny refresh the session agents reads', () => {
    const messages = usePeerMessages('p1', 's1', 'in') as any;
    messages.approve.onSuccess();
    messages.deny.onSuccess();
    expect(invalidated).toEqual([[...qk.project.sessionAgents('p1', 's1')], [...qk.project.sessionAgents('p1', 's1')]]);
  });

  test('task create, update and remove refresh the task list', () => {
    const tasks = useTeamTasks('p1', 's1') as any;
    tasks.create.onSuccess();
    tasks.update.onSuccess();
    tasks.remove.onSuccess();
    expect(invalidated).toEqual([
      [...qk.project.teamTasks('p1', 's1')],
      [...qk.project.teamTasks('p1', 's1')],
      [...qk.project.teamTasks('p1', 's1')],
    ]);
  });

  test('a workflow control shows its answer at once, then refreshes the runs', () => {
    const key = JSON.stringify([...qk.project.sessionWorkflows('p1', 's1')]);
    cache.set(key, [{ runId: 'r1', status: 'running' }, { runId: 'r2', status: 'running' }]);
    const workflows = useSessionWorkflows('p1', 's1') as any;
    workflows.control.onSuccess({ ok: true, paused: true }, { runId: 'r1', body: { action: 'pause' } });
    expect(cache.get(key)).toEqual([{ runId: 'r1', status: 'running', paused: true }, { runId: 'r2', status: 'running' }]);
    expect(invalidated).toEqual([[...qk.project.sessionWorkflows('p1', 's1')]]);
  });

  test('teammates read the session list filtered by team_lead', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: unknown) => {
      calls.push(String(url));
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const { configureKortix } = await import('../core/http/config');
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
    expect(await (useTeammates('p1', 's1') as any).queryFn()).toEqual([]);
    expect(calls[0]).toBe('http://test.local/projects/p1/sessions?limit=50&team_lead=s1');
  });
});

describe('useSessionChildren', () => {
  test('polls when the caller asks, and only then', async () => {
    const { useSessionChildren } = await import('./use-project-sessions');
    // Without the option only the contract's error self-heal (a function) is set: no steady poll.
    expect(typeof (useSessionChildren('p1', 's1') as any).refetchInterval).not.toBe('number');
    const live = useSessionChildren('p1', 's1', { refetchInterval: 5_000 }) as any;
    expect(live.refetchInterval).toBe(5_000);
    expect(live.refetchIntervalInBackground).toBe(false);
  });
});

describe('useSessionChildren keeps the parent row in the session list current', () => {
  const session = (session_id: string, child_count?: number) => ({ session_id, child_count });
  const listKey = (filters: Record<string, unknown>) =>
    JSON.stringify(qk.project.sessionsPaged('p1', 'visible', filters));
  const pageOf = (items: unknown[]) => ({ pages: [{ items, next_cursor: null }], pageParams: [null] });
  const childCountIn = (key: string, sessionId: string) =>
    ((cache.get(key) as any).pages[0].items as Array<{ session_id: string; child_count?: number }>).find(
      (row) => row.session_id === sessionId,
    )?.child_count;

  async function readChildren(count: number, q?: string) {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(Array.from({ length: count }, (_, i) => session(`c${i}`))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const { configureKortix } = await import('../core/http/config');
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
    const { useSessionChildren } = await import('./use-project-sessions');
    await (useSessionChildren('p1', 's1', q ? { q } : undefined) as any).queryFn({ pageParam: null });
  }

  // A spawned session showed in the sidebar only after a reload: the sidebar
  // opens a row's children only when the row's `child_count` is above 0, and
  // that list did not refresh when a child was created.
  test('a child the parent row does not count yet raises its child_count in every list', async () => {
    const roots = listKey({ parent: 'root' });
    const pinned = listKey({ parent: 'root', view: 'pinned' });
    cache.set(roots, pageOf([session('s1', 0), session('s2', 0)]));
    cache.set(pinned, pageOf([session('s1')]));

    await readChildren(2);

    expect(childCountIn(roots, 's1')).toBe(2);
    expect(childCountIn(pinned, 's1')).toBe(2);
    expect(childCountIn(roots, 's2')).toBe(0);
  });

  test('never lowers a count: the parent counts children this viewer cannot list', async () => {
    const roots = listKey({ parent: 'root' });
    const before = pageOf([session('s1', 5)]);
    cache.set(roots, before);

    await readChildren(2);

    expect(cache.get(roots)).toBe(before);
  });

  test('a search over the children says nothing about how many there are', async () => {
    const roots = listKey({ parent: 'root' });
    cache.set(roots, pageOf([session('s1', 0)]));

    await readChildren(1, 'website');

    expect(childCountIn(roots, 's1')).toBe(0);
  });
});
