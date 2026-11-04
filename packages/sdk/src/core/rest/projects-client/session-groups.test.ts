import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  createProjectSessionGroup,
  deleteProjectSessionGroup,
  listProjectSessionGroups,
  renameProjectSessionGroup,
  reorderProjectSessionGroups,
  setProjectSessionGroup,
  type ProjectSessionGroup,
} from './session-groups';
import { listProjectSessionsPage } from './sessions';

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

const storeA: ProjectSessionGroup = {
  group_id: '00000000-0000-4000-8000-00000000000a',
  name: 'Store A',
  position: 0,
  created_by: '00000000-0000-4000-8000-000000000001',
  created_at: '2026-10-27T00:00:00.000Z',
  updated_at: '2026-10-27T00:00:00.000Z',
};
const storeB: ProjectSessionGroup = { ...storeA, group_id: '00000000-0000-4000-8000-00000000000b', name: 'Store B', position: 1 };

test('listProjectSessionGroups GETs the project groups and returns the array in order', async () => {
  nextResponse = { status: 200, body: { groups: [storeA, storeB] } };
  expect(await listProjectSessionGroups('P1')).toEqual([storeA, storeB]);
  expect(calls).toEqual([{ url: 'http://test.local/v1/projects/P1/session-groups', method: 'GET', body: undefined }]);
});

test('createProjectSessionGroup POSTs { name } and returns the group', async () => {
  nextResponse = { status: 201, body: storeA };
  expect(await createProjectSessionGroup('P1', { name: 'Store A' })).toEqual(storeA);
  expect(calls).toEqual([{ url: 'http://test.local/v1/projects/P1/session-groups', method: 'POST', body: { name: 'Store A' } }]);
});

test('renameProjectSessionGroup PATCHes { name } on the group', async () => {
  nextResponse = { status: 200, body: { ...storeA, name: 'Store A (EU)' } };
  expect((await renameProjectSessionGroup('P1', storeA.group_id, 'Store A (EU)')).name).toBe('Store A (EU)');
  expect(calls).toEqual([
    { url: `http://test.local/v1/projects/P1/session-groups/${storeA.group_id}`, method: 'PATCH', body: { name: 'Store A (EU)' } },
  ]);
});

test('deleteProjectSessionGroup DELETEs the group', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  expect(await deleteProjectSessionGroup('P1', storeA.group_id)).toBeUndefined();
  expect(calls).toEqual([
    { url: `http://test.local/v1/projects/P1/session-groups/${storeA.group_id}`, method: 'DELETE', body: undefined },
  ]);
});

test('reorderProjectSessionGroups PUTs every id in the new order and returns the ordered list', async () => {
  const reordered = [{ ...storeB, position: 0 }, { ...storeA, position: 1 }];
  nextResponse = { status: 200, body: { groups: reordered } };
  expect(await reorderProjectSessionGroups('P1', [storeB.group_id, storeA.group_id])).toEqual(reordered);
  expect(calls).toEqual([
    {
      url: 'http://test.local/v1/projects/P1/session-groups/order',
      method: 'PUT',
      body: { group_ids: [storeB.group_id, storeA.group_id] },
    },
  ]);
});

test('setProjectSessionGroup PUTs { group_id } on the session, and null takes it out', async () => {
  nextResponse = { status: 200, body: { session_id: 'S1', group_id: storeA.group_id } };
  expect(await setProjectSessionGroup('P1', 'S1', storeA.group_id)).toEqual({ session_id: 'S1', group_id: storeA.group_id });
  nextResponse = { status: 200, body: { session_id: 'S1', group_id: null } };
  expect(await setProjectSessionGroup('P1', 'S1', null)).toEqual({ session_id: 'S1', group_id: null });
  expect(calls).toEqual([
    { url: 'http://test.local/v1/projects/P1/sessions/S1/group', method: 'PUT', body: { group_id: storeA.group_id } },
    { url: 'http://test.local/v1/projects/P1/sessions/S1/group', method: 'PUT', body: { group_id: null } },
  ]);
});

test('a refusal (409 group_name_taken) rejects with ApiError and never reaches the host error handler', async () => {
  const errors: unknown[] = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok', onError: (e: unknown) => errors.push(e) });
  nextResponse = { status: 409, body: { error: 'Another group in this project already has that name.', code: 'group_name_taken' } };
  const error = await createProjectSessionGroup('P1', { name: 'store a' }).catch((e: unknown) => e);
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'tok' });
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status: 409, code: 'group_name_taken' });
  expect(errors).toEqual([]);
});

test('listProjectSessionsPage sends group as ?group=<id>, or none', async () => {
  nextResponse = { status: 200, body: [] };
  await listProjectSessionsPage('P1', { group: storeA.group_id });
  await listProjectSessionsPage('P1', { group: 'none' });
  expect(calls.map((call) => new URL(call.url).searchParams.get('group'))).toEqual([storeA.group_id, 'none']);
});
