import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-reminders.test.ts`: `useQuery`/`useMutation` return
// their config so the wiring can be asserted without a render tree.
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
  useAddProjectSpaceLink,
  useCreateProjectSpace,
  useOpenProjectDm,
  usePinProjectSpaceLink,
  useProjectSpaceApps,
  useProjectSpaceLinks,
  useProjectSpaces,
  useProjectSpaceSummary,
  useRemoveProjectSpaceLink,
  useUpdateProjectSpace,
} = await import('./use-project-spaces');
const { qk } = await import('./query-keys');
const { configureKortix } = await import('../core/http/config');

let calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  invalidated = [];
  calls = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify({ spaces: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

describe('useProjectSpaces', () => {
  test('reads the spaces list under qk.project.spaces', async () => {
    const query = useProjectSpaces('P1') as any;
    expect(query.queryKey).toEqual(qk.project.spaces('P1'));
    expect(query.enabled).toBe(true);
    expect(await query.queryFn()).toEqual([]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://test.local/projects/P1/spaces' });
  });

  test('is disabled without a project id or when the caller disables it', () => {
    expect((useProjectSpaces(null) as any).enabled).toBe(false);
    expect((useProjectSpaces('P1', { enabled: false }) as any).enabled).toBe(false);
  });
});

describe('space mutations', () => {
  test('create, update and dm call their routes and invalidate the spaces list', async () => {
    const create = useCreateProjectSpace('P1') as any;
    const update = useUpdateProjectSpace('P1') as any;
    const dm = useOpenProjectDm('P1') as any;
    await create.mutationFn({ name: 'Design' });
    await update.mutationFn({ spaceId: 'S1', input: { archived: true } });
    await dm.mutationFn('kortix');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://test.local/projects/P1/spaces',
      'PATCH http://test.local/projects/P1/spaces/S1',
      'POST http://test.local/projects/P1/spaces/dm',
    ]);
    expect(calls.map((c) => c.body)).toEqual([{ name: 'Design' }, { archived: true }, { agent_name: 'kortix' }]);
    create.onSuccess();
    update.onSuccess();
    dm.onSuccess();
    const key = [...qk.project.spaces('P1')];
    expect(invalidated).toEqual([key, key, key]);
  });
});

describe('channel tabs', () => {
  test('apps, links and summary read under the spaces key, per channel', async () => {
    const apps = useProjectSpaceApps('P1', 'S1') as any;
    const links = useProjectSpaceLinks('P1', 'S1') as any;
    const summary = useProjectSpaceSummary('P1', 'S1') as any;
    // Links and the summary sit under the spaces key; a channel's Apps under the App list key.
    const scope = [...qk.project.spaces('P1')];
    for (const query of [links, summary]) {
      expect(query.queryKey.slice(0, scope.length)).toEqual(scope);
    }
    const appsScope = [...qk.project.apps('P1')];
    expect(apps.queryKey.slice(0, appsScope.length)).toEqual(appsScope);
    for (const query of [apps, links, summary]) expect(query.enabled).toBe(true);
    expect(apps.queryKey).toEqual(qk.project.spaceApps('P1', 'S1'));
    expect(links.queryKey).toEqual(qk.project.spaceLinks('P1', 'S1'));
    expect(summary.queryKey).toEqual(qk.project.spaceSummary('P1', 'S1'));
    expect(summary.queryKey).not.toEqual(qk.project.spaceSummary('P1', 'S2'));
    await apps.queryFn();
    await links.queryFn();
    await summary.queryFn();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://test.local/projects/P1/spaces/S1/apps',
      'GET http://test.local/projects/P1/spaces/S1/links',
      'GET http://test.local/projects/P1/spaces/S1/summary',
    ]);
  });

  test('is disabled without a channel id', () => {
    expect((useProjectSpaceApps('P1', null) as any).enabled).toBe(false);
    expect((useProjectSpaceLinks('P1', undefined) as any).enabled).toBe(false);
    expect((useProjectSpaceSummary(null, 'S1') as any).enabled).toBe(false);
  });

  test('adding or removing a link refetches the links and the summary', async () => {
    const add = useAddProjectSpaceLink('P1', 'S1') as any;
    const remove = useRemoveProjectSpaceLink('P1', 'S1') as any;
    await add.mutationFn({ url: 'https://example.test', title: 'Ex' });
    await remove.mutationFn('L1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://test.local/projects/P1/spaces/S1/links',
      'DELETE http://test.local/projects/P1/spaces/S1/links/L1',
    ]);
    expect(calls[0]!.body).toEqual({ url: 'https://example.test', title: 'Ex' });
    await add.onSuccess();
    await remove.onSuccess();
    const both = [[...qk.project.spaceLinks('P1', 'S1')], [...qk.project.spaceSummary('P1', 'S1')]];
    expect(invalidated).toEqual([...both, ...both]);
  });

  test('pinning or unpinning a link PATCHes it and refetches the links and the summary', async () => {
    const pin = usePinProjectSpaceLink('P1', 'S1') as any;
    await pin.mutationFn({ linkId: 'L1', pinned: true });
    await pin.mutationFn({ linkId: 'L1', pinned: false });
    expect(calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body)}`)).toEqual([
      'PATCH http://test.local/projects/P1/spaces/S1/links/L1 {"pinned":true}',
      'PATCH http://test.local/projects/P1/spaces/S1/links/L1 {"pinned":false}',
    ]);
    await pin.onSuccess();
    expect(invalidated).toEqual([[...qk.project.spaceLinks('P1', 'S1')], [...qk.project.spaceSummary('P1', 'S1')]]);
  });
});
