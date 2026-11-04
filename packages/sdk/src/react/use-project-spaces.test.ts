import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-reminders.test.ts`: `useQuery`/`useMutation` return
// their config so the wiring can be asserted without a render tree.
let invalidated: unknown[][] = [];
// Keys whose refetch finished: `invalidateQueries` resolves after the refetch, like TanStack's.
let refetched: unknown[][] = [];
mock.module('@tanstack/react-query', () => ({
  useQuery: (config: Record<string, unknown>) => config,
  useMutation: (config: Record<string, unknown>) => config,
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: unknown[] }) => {
      invalidated.push(opts.queryKey);
      return Promise.resolve().then(() => {
        refetched.push(opts.queryKey);
      });
    },
  }),
}));

const {
  useAddProjectSpaceMembers,
  useJoinProjectSpace,
  useLeaveProjectSpace,
  useProjectSpaceMembers,
  useRemoveProjectSpaceMember,
  useAddProjectSpaceLink,
  useChannelsOnboarding,
  useMarkChannelsOnboarding,
  useProjectSpaceGeneralNotice,
  usePrivateChannelsAvailable,
  useCreateProjectSpace,
  useOpenProjectDm,
  usePinProjectSpaceLink,
  useProjectSpaceApps,
  useProjectSpaceLinks,
  useProjectSpaces,
  useRemoveProjectSpaceLink,
  useUpdateProjectSpace,
} = await import('./use-project-spaces');
const { qk } = await import('./query-keys');
const { configureKortix } = await import('../core/http/config');

let calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  invalidated = [];
  refetched = [];
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
    // Creating a channel or opening a DM completes a "Get started" row.
    const onboarding = [...qk.project.channelsOnboarding('P1')];
    expect(invalidated).toEqual([key, onboarding, key, key, onboarding]);
  });
});

describe('space mutations wait for the refetch', () => {
  test('create, update and dm resolve onSuccess only after every refetch, so the caller sees the new list', async () => {
    const key = [...qk.project.spaces('P1')];
    const onboarding = [...qk.project.channelsOnboarding('P1')];
    for (const [hook, keys] of [
      [useCreateProjectSpace('P1'), [key, onboarding]],
      [useUpdateProjectSpace('P1'), [key]],
      [useOpenProjectDm('P1'), [key, onboarding]],
    ] as const) {
      refetched = [];
      const pending = (hook as any).onSuccess();
      expect(pending).toBeInstanceOf(Promise);
      expect(refetched).toEqual([]);
      await pending;
      expect(refetched).toEqual(keys as unknown as unknown[][]);
    }
  });
});

describe('#general turned-on-again line', () => {
  test('reads general_notice from the spaces route under the spaces key, so a spaces refresh refreshes it', async () => {
    const query = useProjectSpaceGeneralNotice('P1') as any;
    expect(query.queryKey).toEqual(qk.project.spaceGeneralNotice('P1'));
    const prefix = qk.project.spaces('P1');
    expect(query.queryKey.slice(0, prefix.length)).toEqual([...prefix]);
    expect(query.queryKey).not.toEqual(prefix);
    expect(await query.queryFn()).toBeNull();
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://test.local/projects/P1/spaces' });
    expect((useProjectSpaceGeneralNotice(null) as any).enabled).toBe(false);
    expect((useProjectSpaceGeneralNotice('P1', { enabled: false }) as any).enabled).toBe(false);
  });
});

describe('private channels availability', () => {
  test('reads private_channels_available from the spaces route under the spaces key; false when absent', async () => {
    const query = usePrivateChannelsAvailable('P1') as any;
    expect(query.queryKey).toEqual(qk.project.privateChannelsAvailable('P1'));
    const prefix = qk.project.spaces('P1');
    expect(query.queryKey.slice(0, prefix.length)).toEqual([...prefix]);
    expect(query.queryKey).not.toEqual(prefix);
    expect(await query.queryFn()).toBe(false);
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://test.local/projects/P1/spaces' });
    expect((usePrivateChannelsAvailable(null) as any).enabled).toBe(false);
  });
});

describe('Channels onboarding', () => {
  test('reads the onboarding route under its own project key', async () => {
    const query = useChannelsOnboarding('P1') as any;
    expect(query.queryKey).toEqual(qk.project.channelsOnboarding('P1'));
    expect(query.queryKey.slice(0, qk.project.scope('P1').length)).toEqual([...qk.project.scope('P1')]);
    expect(query.enabled).toBe(true);
    await query.queryFn();
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://test.local/projects/P1/onboarding/channels' });
    expect((useChannelsOnboarding(undefined) as any).enabled).toBe(false);
    expect((useChannelsOnboarding('P1', { enabled: false }) as any).enabled).toBe(false);
  });

  test('a mark POSTs { mark } and refreshes the onboarding state only', async () => {
    const mark = useMarkChannelsOnboarding('P1') as any;
    await mark.mutationFn('get_started.dismissed');
    expect(calls).toEqual([
      { method: 'POST', url: 'http://test.local/projects/P1/onboarding/channels/marks', body: { mark: 'get_started.dismissed' } },
    ]);
    await mark.onSuccess();
    expect(invalidated).toEqual([[...qk.project.channelsOnboarding('P1')]]);
  });

  test('a failed mark is silent: the hook handles its own error, so the default error toast does not fire', () => {
    // The next view reads the state again and offers the mark again.
    expect(typeof (useMarkChannelsOnboarding('P1') as any).onError).toBe('function');
  });
});

describe('channel tabs', () => {
  test('apps and links read per channel: links under the spaces key, Apps under the App list key', async () => {
    const apps = useProjectSpaceApps('P1', 'S1') as any;
    const links = useProjectSpaceLinks('P1', 'S1') as any;
    const scope = [...qk.project.spaces('P1')];
    expect(links.queryKey.slice(0, scope.length)).toEqual(scope);
    const appsScope = [...qk.project.apps('P1')];
    expect(apps.queryKey.slice(0, appsScope.length)).toEqual(appsScope);
    for (const query of [apps, links]) expect(query.enabled).toBe(true);
    expect(apps.queryKey).toEqual(qk.project.spaceApps('P1', 'S1'));
    expect(links.queryKey).toEqual(qk.project.spaceLinks('P1', 'S1'));
    expect(links.queryKey).not.toEqual(qk.project.spaceLinks('P1', 'S2'));
    await apps.queryFn();
    await links.queryFn();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://test.local/projects/P1/spaces/S1/apps',
      'GET http://test.local/projects/P1/spaces/S1/links',
    ]);
  });

  test('is disabled without a channel id', () => {
    expect((useProjectSpaceApps('P1', null) as any).enabled).toBe(false);
    expect((useProjectSpaceLinks('P1', undefined) as any).enabled).toBe(false);
  });

  test('adding or removing a link refetches the links', async () => {
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
    const links = [...qk.project.spaceLinks('P1', 'S1')];
    expect(invalidated).toEqual([links, links]);
  });

  test('pinning or unpinning a link PATCHes it and refetches the links', async () => {
    const pin = usePinProjectSpaceLink('P1', 'S1') as any;
    await pin.mutationFn({ linkId: 'L1', pinned: true });
    await pin.mutationFn({ linkId: 'L1', pinned: false });
    expect(calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body)}`)).toEqual([
      'PATCH http://test.local/projects/P1/spaces/S1/links/L1 {"pinned":true}',
      'PATCH http://test.local/projects/P1/spaces/S1/links/L1 {"pinned":false}',
    ]);
    await pin.onSuccess();
    expect(invalidated).toEqual([[...qk.project.spaceLinks('P1', 'S1')]]);
  });
});

describe('channel members', () => {
  test('read the members route under the spaces key, so a spaces refresh refreshes the roster', async () => {
    const query = useProjectSpaceMembers('P1', 'S1') as any;
    expect(query.queryKey).toEqual(qk.project.spaceMembers('P1', 'S1'));
    const prefix = qk.project.spaces('P1');
    expect(query.queryKey.slice(0, prefix.length)).toEqual([...prefix]);
    expect(query.enabled).toBe(true);
    await query.queryFn();
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'http://test.local/projects/P1/spaces/S1/members' });
    expect((useProjectSpaceMembers('P1', null) as any).enabled).toBe(false);
  });

  test('add, remove, join and leave call their routes and refetch the spaces list (members and is_member)', async () => {
    const add = useAddProjectSpaceMembers('P1', 'S1') as any;
    const remove = useRemoveProjectSpaceMember('P1', 'S1') as any;
    const join = useJoinProjectSpace('P1', 'S1') as any;
    const leave = useLeaveProjectSpace('P1', 'S1') as any;
    await add.mutationFn(['U2']);
    await remove.mutationFn('U2');
    await join.mutationFn();
    await leave.mutationFn();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://test.local/projects/P1/spaces/S1/members',
      'DELETE http://test.local/projects/P1/spaces/S1/members/U2',
      'POST http://test.local/projects/P1/spaces/S1/join',
      'DELETE http://test.local/projects/P1/spaces/S1/members/me',
    ]);
    expect(calls[0]!.body).toEqual({ user_ids: ['U2'] });
    for (const hook of [add, remove, join, leave]) await hook.onSuccess();
    const key = [...qk.project.spaces('P1')];
    expect(invalidated).toEqual([key, key, key, key]);
  });
});
