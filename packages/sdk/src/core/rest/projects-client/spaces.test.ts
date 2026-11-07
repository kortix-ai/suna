import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  addWorkspaceSpaceLink,
  createWorkspaceSpace,
  getChannelsOnboarding,
  getOrCreateWorkspaceDm,
  getWorkspaceSpaceGeneralNotice,
  getPrivateChannelsAvailable,
  addWorkspaceSpaceMembers,
  joinWorkspaceSpace,
  leaveWorkspaceSpace,
  listWorkspaceSpaceMembers,
  removeWorkspaceSpaceMember,
  markChannelsOnboarding,
  listWorkspaceSpaceApps,
  listWorkspaceSpaceLinks,
  listWorkspaceSpaces,
  listPrivateChannelsNotIn,
  pinWorkspaceSpaceLink,
  removeWorkspaceSpaceLink,
  getWorkspaceSpaceProactive,
  setWorkspaceSpaceProactive,
  setWorkspaceSpaceTabs,
  updateWorkspaceSpace,
  type ChannelsOnboarding,
  type ProjectSpace,
  type ProjectSpaceLink,
  type ProjectSpaceMemberList,
  type ProjectSpaceProactive,
  type ProjectSpaceTab,
  type ProjectSpaceTabKind,
} from './spaces';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });

const general: ProjectSpace = {
  space_id: '00000000-0000-4000-8000-000000000001',
  kind: 'channel',
  slug: 'general',
  name: 'general',
  description: null,
  is_default: true,
  dm_agent_name: null,
  archived_at: null,
  created_at: '2026-10-20T00:00:00.000Z',
  updated_at: '2026-10-20T00:00:00.000Z',
};

test('listProjectSpaces GETs the project spaces and returns the array', async () => {
  nextResponse = { status: 200, body: { spaces: [general] } };
  const spaces = await listWorkspaceSpaces('P1');
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/spaces', method: 'GET', body: undefined }]);
  expect(spaces).toEqual([general]);
});

test('getProjectSpaceGeneralNotice reads #general\'s turned-on-again line from the spaces list, or null', async () => {
  const notice = { kind: 'reenabled' as const, at: '2026-10-23T00:00:00.000Z', count: 4 };
  nextResponse = { status: 200, body: { spaces: [general], general_notice: notice } };
  expect(await getWorkspaceSpaceGeneralNotice('P1')).toEqual(notice);
  nextResponse = { status: 200, body: { spaces: [general] } };
  expect(await getWorkspaceSpaceGeneralNotice('P1')).toBeNull();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'GET http://test.local/v1/workspaces/P1/spaces',
    'GET http://test.local/v1/workspaces/P1/spaces',
  ]);
});

test('getPrivateChannelsAvailable reads private_channels_available from the spaces list; an older API that sends none reads false', async () => {
  nextResponse = { status: 200, body: { spaces: [general], private_channels_available: true } };
  expect(await getPrivateChannelsAvailable('P1')).toBe(true);
  nextResponse = { status: 200, body: { spaces: [general] } };
  expect(await getPrivateChannelsAvailable('P1')).toBe(false);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'GET http://test.local/v1/workspaces/P1/spaces',
    'GET http://test.local/v1/workspaces/P1/spaces',
  ]);
});

test('listPrivateChannelsNotIn GETs the manager list of private channels and returns its array', async () => {
  const row = {
    space_id: '00000000-0000-4000-8000-000000000009',
    name: 'deals',
    slug: 'deals',
    member_count: 0,
    created_by: null,
    created_by_name: null,
    created_at: '2026-10-20T00:00:00.000Z',
    archived_at: null,
  };
  nextResponse = { status: 200, body: { channels: [row] } };
  expect(await listPrivateChannelsNotIn('P1')).toEqual([row]);
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/spaces/private', method: 'GET', body: undefined }]);
});

test('getChannelsOnboarding GETs the caller\'s onboarding state', async () => {
  const state: ChannelsOnboarding = {
    intro_seen: false,
    get_started: { visible: true, create_channel: true, remember: false, open_dm: false },
  };
  nextResponse = { status: 200, body: state };
  expect(await getChannelsOnboarding('P1')).toEqual(state);
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/onboarding/channels', method: 'GET', body: undefined }]);
});

test('markChannelsOnboarding POSTs { mark } and resolves on 204', async () => {
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  expect(await markChannelsOnboarding('P1', 'channels_intro')).toBeUndefined();
  expect(calls).toEqual([
    { url: 'http://test.local/v1/workspaces/P1/onboarding/channels/marks', method: 'POST', body: { mark: 'channels_intro' } },
  ]);
});

test('markChannelsOnboarding rejects an unknown mark with 400 and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 400, body: { error: true, message: 'Validation failed' } };
  const error = await markChannelsOnboarding('P1', 'nope' as never).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 400 });
  expect(errors).toEqual([]);
});

test('createProjectSpace POSTs the name and description', async () => {
  nextResponse = { status: 201, body: { ...general, slug: 'design', name: 'Design', is_default: false } };
  const space = await createWorkspaceSpace('P1', { name: 'Design', description: 'UI work' });
  expect(calls[0]).toEqual({
    url: 'http://test.local/v1/workspaces/P1/spaces',
    method: 'POST',
    body: { name: 'Design', description: 'UI work' },
  });
  expect(space.slug).toBe('design');
});

test('createProjectSpace sends visibility private and reads the channel back as private', async () => {
  nextResponse = { status: 201, body: { ...general, slug: 'deals', name: 'deals', is_default: false, visibility: 'private' } };
  const space = await createWorkspaceSpace('P1', { name: 'deals', visibility: 'private' });
  expect(calls[0]!.body).toEqual({ name: 'deals', visibility: 'private' });
  const visibility: 'public' | 'private' | undefined = space.visibility;
  expect(visibility).toBe('private');
});

test('updateProjectSpace makes a public channel private', async () => {
  nextResponse = { status: 200, body: { ...general, visibility: 'private' } };
  await updateWorkspaceSpace('P1', general.space_id, { visibility: 'private' });
  expect(calls[0]!.body).toEqual({ visibility: 'private' });
});

test('createProjectSpace rejects a taken slug with code slug_taken and the existing space', async () => {
  nextResponse = {
    status: 409,
    body: { error: 'A channel with this name exists', code: 'slug_taken', space_id: general.space_id, archived: true },
  };
  const error = await createWorkspaceSpace('P1', { name: 'general' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 409,
    code: 'slug_taken',
    data: { space_id: general.space_id, archived: true },
  });
});

test('updateProjectSpace PATCHes the space by id', async () => {
  nextResponse = { status: 200, body: { ...general, archived_at: '2026-10-20T01:00:00.000Z' } };
  const space = await updateWorkspaceSpace('P1', general.space_id, { archived: true, description: null });
  expect(calls[0]).toEqual({
    url: `http://test.local/v1/workspaces/P1/spaces/${general.space_id}`,
    method: 'PATCH',
    body: { archived: true, description: null },
  });
  expect(space.archived_at).toBe('2026-10-20T01:00:00.000Z');
});

test('updateProjectSpace sends the channel agent list in order and reads it back, first agent the default', async () => {
  nextResponse = { status: 200, body: { ...general, agents: ['writer', 'kortix'] } };
  const space = await updateWorkspaceSpace('P1', general.space_id, { agents: ['writer', 'kortix'] });
  expect(calls[0]).toEqual({
    url: `http://test.local/v1/workspaces/P1/spaces/${general.space_id}`,
    method: 'PATCH',
    body: { agents: ['writer', 'kortix'] },
  });
  const agents: string[] | undefined = space.agents;
  expect(agents).toEqual(['writer', 'kortix']);
});

test('updateProjectSpace rejects a taken slug with slug_taken and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = {
    status: 409,
    body: { error: 'A channel with this name exists', code: 'slug_taken', space_id: general.space_id, archived: false },
  };
  const error = await updateWorkspaceSpace('P1', 'S2', { name: 'general' }).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 409, code: 'slug_taken', data: { space_id: general.space_id, archived: false } });
  expect(errors).toEqual([]);
});

test('getOrCreateProjectDm POSTs the agent name to the DM route', async () => {
  nextResponse = {
    status: 200,
    body: { ...general, kind: 'dm', slug: null, name: 'kortix', is_default: false, dm_agent_name: 'kortix' },
  };
  const dm = await getOrCreateWorkspaceDm('P1', 'kortix');
  expect(calls[0]).toEqual({
    url: 'http://test.local/v1/workspaces/P1/spaces/dm',
    method: 'POST',
    body: { agent_name: 'kortix' },
  });
  expect(dm.kind).toBe('dm');
  expect(dm.dm_agent_name).toBe('kortix');
});

test('getOrCreateProjectDm rejects an unknown agent with agent_not_found and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 404, body: { error: 'Agent not found', code: 'agent_not_found' } };
  const error = await getOrCreateWorkspaceDm('P1', 'ghost').catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 404, code: 'agent_not_found' });
  expect(errors).toEqual([]);
});

const link: ProjectSpaceLink = {
  link_id: 'L1',
  space_id: general.space_id,
  url: 'https://example.test/spec',
  title: 'Spec',
  created_by: 'U1',
  created_by_name: 'Ana',
  created_at: '2026-10-21T00:00:00.000Z',
  can_delete: true,
  pinned: false,
  pinned_by_name: null,
  pinned_at: null,
  source: 'message',
  session_id: 'T1',
  last_shared_at: '2026-10-22T00:00:00.000Z',
  display_title: 'Spec',
  site_name: 'Example',
  icon_url: 'https://example.test/favicon.ico',
};

// A link built by a consumer without the fetched fields (an older API, a hand-made fixture) still type-checks.
const legacyLink: ProjectSpaceLink = (({ display_title, site_name, icon_url, ...rest }) => rest)(link);

test('a link from an API without the fetched fields lists unchanged', async () => {
  nextResponse = { status: 200, body: { links: [legacyLink] } };
  expect(await listWorkspaceSpaceLinks('P1', 'S1')).toEqual([legacyLink]);
});

test('listProjectSpaceApps GETs the channel apps and returns the array', async () => {
  nextResponse = { status: 200, body: { apps: [{ app_id: 'A1' }] } };
  const apps = await listWorkspaceSpaceApps('P1', 'S1');
  expect(calls).toEqual([{ url: 'http://test.local/v1/workspaces/P1/spaces/S1/apps', method: 'GET', body: undefined }]);
  expect(apps).toEqual([{ app_id: 'A1' }] as never);
});

test('space links: list GETs, add POSTs url and title, remove DELETEs by id', async () => {
  nextResponse = { status: 200, body: { links: [link] } };
  expect(await listWorkspaceSpaceLinks('P1', 'S1')).toEqual([link]);
  nextResponse = { status: 201, body: link };
  expect(await addWorkspaceSpaceLink('P1', 'S1', { url: link.url, title: 'Spec' })).toEqual(link);
  nextResponse = { status: 200, body: { ok: true } };
  await removeWorkspaceSpaceLink('P1', 'S1', 'L1');
  expect(calls).toEqual([
    { url: 'http://test.local/v1/workspaces/P1/spaces/S1/links', method: 'GET', body: undefined },
    { url: 'http://test.local/v1/workspaces/P1/spaces/S1/links', method: 'POST', body: { url: link.url, title: 'Spec' } },
    { url: 'http://test.local/v1/workspaces/P1/spaces/S1/links/L1', method: 'DELETE', body: undefined },
  ]);
});

test('pinProjectSpaceLink PATCHes { pinned } and returns the link, or null from an older server that removed it on unpin', async () => {
  const pinned = { ...link, pinned: true, pinned_by_name: 'Ana', pinned_at: '2026-10-23T00:00:00.000Z' };
  nextResponse = { status: 200, body: { link: pinned } };
  expect(await pinWorkspaceSpaceLink('P1', 'S1', 'L1', true)).toEqual(pinned);
  nextResponse = { status: 200, body: { link: null } };
  expect(await pinWorkspaceSpaceLink('P1', 'S1', 'L1', false)).toBeNull();
  expect(calls).toEqual([
    { url: 'http://test.local/v1/workspaces/P1/spaces/S1/links/L1', method: 'PATCH', body: { pinned: true } },
    { url: 'http://test.local/v1/workspaces/P1/spaces/S1/links/L1', method: 'PATCH', body: { pinned: false } },
  ]);
});

test('pinProjectSpaceLink rejects a full channel with 409 link_limit and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 409, body: { error: 'A channel pins at most 200 links. Unpin one first.', code: 'link_limit' } };
  const error = await pinWorkspaceSpaceLink('P1', 'S1', 'L1', true).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 409, code: 'link_limit' });
  expect(errors).toEqual([]);
});

test('addProjectSpaceLink rejects a bad url with 400 and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 400, body: { error: true, message: 'Validation failed' } };
  const error = await addWorkspaceSpaceLink('P1', 'S1', { url: 'ftp://x' }).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 400 });
  expect(errors).toEqual([]);
});

const memberList: ProjectSpaceMemberList = {
  members: [
    {
      user_id: 'U1',
      name: 'Priya Rao',
      avatar_url: null,
      is_creator: true,
      is_viewer: true,
      added_at: '2026-10-25T00:00:00.000Z',
      can_remove: false,
    },
  ],
  implicit: false,
  can_add: true,
};

test('channel members: list, add in bulk, remove, join and leave reach their routes and return the list', async () => {
  nextResponse = { status: 200, body: memberList };
  const base = 'http://test.local/v1/workspaces/P1/spaces/S1';
  expect(await listWorkspaceSpaceMembers('P1', 'S1')).toEqual(memberList);
  expect(await addWorkspaceSpaceMembers('P1', 'S1', ['U2', 'U3'])).toEqual(memberList);
  expect(await removeWorkspaceSpaceMember('P1', 'S1', 'U2')).toEqual(memberList);
  expect(await joinWorkspaceSpace('P1', 'S1')).toEqual(memberList);
  expect(await leaveWorkspaceSpace('P1', 'S1')).toEqual(memberList);
  expect(calls).toEqual([
    { url: `${base}/members`, method: 'GET', body: undefined },
    { url: `${base}/members`, method: 'POST', body: { user_ids: ['U2', 'U3'] } },
    { url: `${base}/members/U2`, method: 'DELETE', body: undefined },
    { url: `${base}/join`, method: 'POST', body: undefined },
    { url: `${base}/members/me`, method: 'DELETE', body: undefined },
  ]);
});

test('adding someone outside the project rejects with ApiError 400 not_project_member', async () => {
  nextResponse = { status: 400, body: { error: 'Only members of the project can be added to a channel.', code: 'not_project_member', user_ids: ['U9'] } };
  const error = await addWorkspaceSpaceMembers('P1', 'S1', ['U9']).catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.status).toBe(400);
  expect(error.code).toBe('not_project_member');
});

test('setProjectSpaceTabs PUTs the whole ordered list and returns the space with its tabs', async () => {
  const tabs: ProjectSpaceTab[] = [
    { id: 'page', title: 'Launch page', kind: 'file', ref: '/Company/Channels/general/launch.html' },
    { id: 'docs', title: 'Docs', kind: 'link', ref: 'https://example.test/docs' },
  ];
  nextResponse = { status: 200, body: { ...general, tabs: [tabs[0], { ...tabs[1], embeddable: false }] } };
  const space = await setWorkspaceSpaceTabs('P1', general.space_id, tabs);
  expect(calls).toEqual([
    { url: `http://test.local/v1/workspaces/P1/spaces/${general.space_id}/tabs`, method: 'PUT', body: { tabs } },
  ]);
  // The server sets a link tab's embeddable.
  expect(space.tabs).toEqual([tabs[0]!, { ...tabs[1]!, embeddable: false }]);
});

test('getProjectSpaceProactive GETs the space watcher settings', async () => {
  const settings: ProjectSpaceProactive = { space_id: general.space_id, enabled: false, daily_brief: false, brief_timezone: 'UTC', can_edit: true };
  nextResponse = { status: 200, body: settings };
  expect(await getWorkspaceSpaceProactive('P1', general.space_id)).toEqual(settings);
  expect(calls).toEqual([{ url: `http://test.local/v1/workspaces/P1/spaces/${general.space_id}/proactive`, method: 'GET', body: undefined }]);
});

test('setProjectSpaceProactive PUTs only the fields given and returns the stored settings', async () => {
  nextResponse = { status: 200, body: { space_id: general.space_id, enabled: true, daily_brief: true, brief_timezone: 'Europe/Berlin', can_edit: true } };
  const stored = await setWorkspaceSpaceProactive('P1', general.space_id, { daily_brief: true, brief_timezone: 'Europe/Berlin' });
  expect(calls).toEqual([
    { url: `http://test.local/v1/workspaces/P1/spaces/${general.space_id}/proactive`, method: 'PUT', body: { daily_brief: true, brief_timezone: 'Europe/Berlin' } },
  ]);
  expect(stored.enabled).toBe(true);
});

test('setProjectSpaceProactive rejects with the API error code (403 forbidden)', async () => {
  nextResponse = { status: 403, body: { error: 'Only the space’s creator, a project manager or the DM’s owner can change Proactive.', code: 'forbidden' } };
  const error = (await setWorkspaceSpaceProactive('P1', general.space_id, { enabled: true }).catch((e: unknown) => e)) as { code?: string };
  expect(error.code).toBe('forbidden');
});

test('ProjectSpaceTabKind is file | folder | artifact | app | link, and every tab has a ref', () => {
  const kinds: ProjectSpaceTabKind[] = ['file', 'folder', 'artifact', 'app', 'link'];
  // @ts-expect-error threads is not a tab kind any more
  const threads: ProjectSpaceTabKind = 'threads';
  // @ts-expect-error memory is not a tab kind any more
  const memory: ProjectSpaceTabKind = 'memory';
  // @ts-expect-error a tab without a ref
  const noRef: ProjectSpaceTab = { id: 'x', title: 'X', kind: 'app' };
  expect([kinds.length, threads, memory, noRef.id]).toEqual([5, 'threads', 'memory', 'x']);
});

test('setProjectSpaceTabs rejects a refusal with ApiError and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 403, body: { error: 'no', code: 'forbidden' } };
  const error = await setWorkspaceSpaceTabs('P1', 'S2', []).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 403, code: 'forbidden' });
  expect(errors).toEqual([]);
});
