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

const { useCreateProjectSpace, useOpenProjectDm, useProjectSpaces, useUpdateProjectSpace } = await import(
  './use-project-spaces'
);
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
