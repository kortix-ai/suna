import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  addProjectSpaceLink,
  createProjectSpace,
  getOrCreateProjectDm,
  getProjectSpaceSummary,
  listProjectSpaceApps,
  listProjectSpaceLinks,
  listProjectSpaces,
  removeProjectSpaceLink,
  updateProjectSpace,
  type ProjectSpace,
  type ProjectSpaceLink,
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
  const spaces = await listProjectSpaces('P1');
  expect(calls).toEqual([{ url: 'http://test.local/v1/projects/P1/spaces', method: 'GET', body: undefined }]);
  expect(spaces).toEqual([general]);
});

test('createProjectSpace POSTs the name and description', async () => {
  nextResponse = { status: 201, body: { ...general, slug: 'design', name: 'Design', is_default: false } };
  const space = await createProjectSpace('P1', { name: 'Design', description: 'UI work' });
  expect(calls[0]).toEqual({
    url: 'http://test.local/v1/projects/P1/spaces',
    method: 'POST',
    body: { name: 'Design', description: 'UI work' },
  });
  expect(space.slug).toBe('design');
});

test('createProjectSpace rejects a taken slug with code slug_taken and the existing space', async () => {
  nextResponse = {
    status: 409,
    body: { error: 'A channel with this name exists', code: 'slug_taken', space_id: general.space_id, archived: true },
  };
  const error = await createProjectSpace('P1', { name: 'general' }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    status: 409,
    code: 'slug_taken',
    data: { space_id: general.space_id, archived: true },
  });
});

test('updateProjectSpace PATCHes the space by id', async () => {
  nextResponse = { status: 200, body: { ...general, archived_at: '2026-10-20T01:00:00.000Z' } };
  const space = await updateProjectSpace('P1', general.space_id, { archived: true, description: null });
  expect(calls[0]).toEqual({
    url: `http://test.local/v1/projects/P1/spaces/${general.space_id}`,
    method: 'PATCH',
    body: { archived: true, description: null },
  });
  expect(space.archived_at).toBe('2026-10-20T01:00:00.000Z');
});

test('updateProjectSpace rejects a taken slug with slug_taken and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = {
    status: 409,
    body: { error: 'A channel with this name exists', code: 'slug_taken', space_id: general.space_id, archived: false },
  };
  const error = await updateProjectSpace('P1', 'S2', { name: 'general' }).catch((e: unknown) => e);
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
  const dm = await getOrCreateProjectDm('P1', 'kortix');
  expect(calls[0]).toEqual({
    url: 'http://test.local/v1/projects/P1/spaces/dm',
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
  const error = await getOrCreateProjectDm('P1', 'ghost').catch((e: unknown) => e);
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
};

test('listProjectSpaceApps GETs the channel apps and returns the array', async () => {
  nextResponse = { status: 200, body: { apps: [{ app_id: 'A1' }] } };
  const apps = await listProjectSpaceApps('P1', 'S1');
  expect(calls).toEqual([{ url: 'http://test.local/v1/projects/P1/spaces/S1/apps', method: 'GET', body: undefined }]);
  expect(apps).toEqual([{ app_id: 'A1' }] as never);
});

test('space links: list GETs, add POSTs url and title, remove DELETEs by id', async () => {
  nextResponse = { status: 200, body: { links: [link] } };
  expect(await listProjectSpaceLinks('P1', 'S1')).toEqual([link]);
  nextResponse = { status: 201, body: link };
  expect(await addProjectSpaceLink('P1', 'S1', { url: link.url, title: 'Spec' })).toEqual(link);
  nextResponse = { status: 200, body: { ok: true } };
  await removeProjectSpaceLink('P1', 'S1', 'L1');
  expect(calls).toEqual([
    { url: 'http://test.local/v1/projects/P1/spaces/S1/links', method: 'GET', body: undefined },
    { url: 'http://test.local/v1/projects/P1/spaces/S1/links', method: 'POST', body: { url: link.url, title: 'Spec' } },
    { url: 'http://test.local/v1/projects/P1/spaces/S1/links/L1', method: 'DELETE', body: undefined },
  ]);
});

test('addProjectSpaceLink rejects a bad url with 400 and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 400, body: { error: true, message: 'Validation failed' } };
  const error = await addProjectSpaceLink('P1', 'S1', { url: 'ftp://x' }).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 400 });
  expect(errors).toEqual([]);
});

test('getProjectSpaceSummary GETs the tab counts', async () => {
  nextResponse = { status: 200, body: { apps: 2, links: 3 } };
  expect(await getProjectSpaceSummary('P1', 'S1')).toEqual({ apps: 2, links: 3 });
  expect(calls[0]).toEqual({ url: 'http://test.local/v1/projects/P1/spaces/S1/summary', method: 'GET', body: undefined });
});
