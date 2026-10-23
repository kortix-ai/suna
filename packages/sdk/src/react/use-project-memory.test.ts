import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-project-spaces.test.ts`: `useQuery`/`useMutation`
// return their config so the wiring is asserted without a render tree.
let invalidated: unknown[][] = [];
let cached: { key: unknown[]; data: unknown }[] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useInfiniteQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
    setQueryData: (key: unknown[], data: unknown) => {
      cached.push({ key, data });
    },
  }),
}));

const {
  useAddProjectMemoryNote,
  useCreateProjectMemoryPage,
  useDeleteProjectMemoryPage,
  useProjectMemoryChanges,
  useProjectMemoryHistory,
  useProjectMemoryLayer,
  useProjectMemoryPage,
  useProjectMemoryPages,
  useRestoreProjectMemoryPage,
  useUndoProjectMemoryVersion,
  useUpdateProjectMemoryPage,
} = await import('./use-project-memory');
const { qk } = await import('./query-keys');
const { configureKortix } = await import('../core/http/config');

let calls: { url: string; method: string; body: unknown }[] = [];
let response: unknown = {};
beforeEach(() => {
  invalidated = [];
  cached = [];
  calls = [];
  response = {};
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

const base = 'http://test.local/projects/P1/memory';

describe('memory query keys', () => {
  test('every memory key sits under the project scope and one memory prefix', () => {
    const prefix = qk.project.memory('P1');
    expect(prefix.slice(0, qk.project.scope('P1').length)).toEqual([...qk.project.scope('P1')]);
    for (const key of [
      qk.project.memoryLayer('P1', 'company'),
      qk.project.memoryPages('P1', 'company'),
      qk.project.memoryChanges('P1', 'company'),
      qk.project.memoryPage('P1', 'PG1'),
      qk.project.memoryHistory('P1', 'PG1'),
    ]) {
      expect(key.slice(0, prefix.length)).toEqual([...prefix]);
    }
  });

  test('two layers and two pages get their own cache slots', () => {
    expect(qk.project.memoryPages('P1', 'company')).not.toEqual(qk.project.memoryPages('P1', 'S1') as never);
    expect(qk.project.memoryPage('P1', 'PG1')).not.toEqual(qk.project.memoryPage('P1', 'PG2') as never);
    expect(qk.project.memoryHistory('P1', 'PG1')).not.toEqual(qk.project.memoryPage('P1', 'PG1') as never);
  });
});

describe('memory reads', () => {
  test('each read uses its key and route', async () => {
    response = { pages: [] };
    const reads = [
      [useProjectMemoryLayer('P1', 'company'), qk.project.memoryLayer('P1', 'company'), `GET ${base}/layers/company`],
      [useProjectMemoryPages('P1', 'S1'), qk.project.memoryPages('P1', 'S1'), `GET ${base}/layers/S1/pages`],
      [useProjectMemoryChanges('P1', 'S1'), qk.project.memoryChanges('P1', 'S1'), `GET ${base}/layers/S1/changes`],
      [useProjectMemoryPage('P1', 'PG1'), qk.project.memoryPage('P1', 'PG1'), `GET ${base}/pages/PG1`],
      [useProjectMemoryHistory('P1', 'PG1'), qk.project.memoryHistory('P1', 'PG1'), `GET ${base}/pages/PG1/history`],
    ] as const;
    for (const [query, key] of reads) {
      expect((query as any).queryKey).toEqual(key);
      expect((query as any).enabled).toBe(true);
      await (query as any).queryFn({ pageParam: undefined });
    }
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(reads.map((r) => r[2]));
  });

  test('Recent changes and history page with next → before', async () => {
    response = { changes: [], next: null };
    const changes = useProjectMemoryChanges('P1', 'S1') as any;
    const history = useProjectMemoryHistory('P1', 'PG1') as any;
    await changes.queryFn({ pageParam: 'C2' });
    await history.queryFn({ pageParam: 'V9' });
    expect(calls.map((c) => c.url)).toEqual([`${base}/layers/S1/changes?before=C2`, `${base}/pages/PG1/history?before=V9`]);
    for (const query of [changes, history]) {
      expect(query.initialPageParam).toBeUndefined();
      expect(query.getNextPageParam({ next: 'N2' })).toBe('N2');
      expect(query.getNextPageParam({ next: null })).toBeUndefined();
    }
  });

  test('a read is disabled without its ids or when the caller disables it', () => {
    expect((useProjectMemoryLayer(null, 'company') as any).enabled).toBe(false);
    expect((useProjectMemoryPages('P1', null) as any).enabled).toBe(false);
    expect((useProjectMemoryChanges('P1', undefined) as any).enabled).toBe(false);
    expect((useProjectMemoryPage('P1', null) as any).enabled).toBe(false);
    expect((useProjectMemoryHistory('P1', null) as any).enabled).toBe(false);
    expect((useProjectMemoryPages('P1', 'S1', { enabled: false }) as any).enabled).toBe(false);
  });
});

describe('memory mutations', () => {
  // Every write can change the layer counts, its page list, Recent changes and
  // any page of the change (a filed note touches two pages), and the tab counts.
  const everyMemoryKey = () => [[...qk.project.memory('P1')], [...qk.project.spaceSummaries('P1')]];

  test('create and note POST to the layer and invalidate memory and the tab counts', async () => {
    const create = useCreateProjectMemoryPage('P1', 'S1') as any;
    const note = useAddProjectMemoryNote('P1', 'S1') as any;
    await create.mutationFn({ type: 'people', title: 'Priya' });
    await note.mutationFn({ text: 'Priya owns the Northwind launch' });
    expect(calls).toEqual([
      { method: 'POST', url: `${base}/layers/S1/pages`, body: { type: 'people', title: 'Priya' } },
      { method: 'POST', url: `${base}/layers/S1/notes`, body: { text: 'Priya owns the Northwind launch' } },
    ]);
    await create.onSuccess();
    expect(invalidated).toEqual(everyMemoryKey());
    invalidated = [];
    await note.onSuccess();
    expect(invalidated).toEqual(everyMemoryKey());
  });

  test('update PATCHes the page, writes the result into its cache slot and invalidates memory', async () => {
    const update = useUpdateProjectMemoryPage('P1') as any;
    const saved = { page_id: 'PG1', version_no: 4 };
    response = saved;
    await update.mutationFn({ pageId: 'PG1', input: { base_version: 3, title: 'Priya S.' } });
    expect(calls).toEqual([{ method: 'PATCH', url: `${base}/pages/PG1`, body: { base_version: 3, title: 'Priya S.' } }]);
    await update.onSuccess(saved);
    expect(cached).toEqual([{ key: [...qk.project.memoryPage('P1', 'PG1')], data: saved }]);
    expect(invalidated).toEqual(everyMemoryKey());
  });

  test('restore POSTs the version, writes the result into the page slot and invalidates memory', async () => {
    const restore = useRestoreProjectMemoryPage('P1') as any;
    const restored = { page_id: 'PG1', version_no: 5 };
    response = restored;
    await restore.mutationFn({ pageId: 'PG1', versionId: 'V1' });
    expect(calls).toEqual([{ method: 'POST', url: `${base}/pages/PG1/restore`, body: { version_id: 'V1' } }]);
    await restore.onSuccess(restored);
    expect(cached).toEqual([{ key: [...qk.project.memoryPage('P1', 'PG1')], data: restored }]);
    expect(invalidated).toEqual(everyMemoryKey());
  });

  test('undo writes every page it changed into its cache slot', async () => {
    const undo = useUndoProjectMemoryVersion('P1') as any;
    const note = { page_id: 'PG2', version_no: 2 };
    const target = { page_id: 'PG1', version_no: 7 };
    await undo.onSuccess({ pages: [note, target] });
    expect(cached).toEqual([
      { key: [...qk.project.memoryPage('P1', 'PG2')], data: note },
      { key: [...qk.project.memoryPage('P1', 'PG1')], data: target },
    ]);
    expect(invalidated).toEqual(everyMemoryKey());
  });

  test('delete and undo call their routes and invalidate memory, the pages included', async () => {
    const remove = useDeleteProjectMemoryPage('P1') as any;
    const undo = useUndoProjectMemoryVersion('P1') as any;
    await remove.mutationFn('PG1');
    await undo.mutationFn('V1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${base}/pages/PG1`,
      `POST ${base}/versions/V1/undo`,
    ]);
    await remove.onSuccess();
    expect(invalidated).toEqual(everyMemoryKey());
    invalidated = [];
    await undo.onSuccess({ pages: [] });
    expect(invalidated).toEqual(everyMemoryKey());
    // The memory prefix covers the page and its history.
    const prefix = qk.project.memory('P1');
    expect(qk.project.memoryPage('P1', 'PG1').slice(0, prefix.length)).toEqual([...prefix]);
  });

  test('every mutation handles its own error, so the app-wide default error toast does not fire as well', () => {
    // Each caller shows a specific message for 409/413/422. Without a hook-level
    // onError, TanStack also runs the QueryClient's default mutation onError.
    for (const hook of [
      useCreateProjectMemoryPage('P1', 'company'),
      useAddProjectMemoryNote('P1', 'company'),
      useUpdateProjectMemoryPage('P1'),
      useDeleteProjectMemoryPage('P1'),
      useRestoreProjectMemoryPage('P1'),
      useUndoProjectMemoryVersion('P1'),
    ] as any[]) {
      expect(typeof hook.onError).toBe('function');
    }
  });
});
