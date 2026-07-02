import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import {
  createProjectResourceGrant,
  deleteProjectResourceGrant,
  listProjectResourceGrants,
} from './index';

let calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        grant_id: 'g1',
        resources: { agents: [], skills: [], secrets: [] },
        grants: [],
        ok: true,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('listProjectResourceGrants hits the resource-grants collection', async () => {
  const result = await listProjectResourceGrants('P1');
  expect(last().url).toContain('/projects/P1/resource-grants');
  expect(last().method).toBe('GET');
  expect(result.resources.secrets).toEqual([]);
});

test('createProjectResourceGrant posts a snake_case grant body', async () => {
  await createProjectResourceGrant('P1', {
    resourceType: 'secret',
    resourceId: 'MY_SECRET',
    principalType: 'member',
    principalId: 'user-1',
  });
  expect(last().url).toContain('/projects/P1/resource-grants');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({
    resource_type: 'secret',
    resource_id: 'MY_SECRET',
    principal_type: 'member',
    principal_id: 'user-1',
  });
});

test('createProjectResourceGrant forwards an explicit expiry (including null)', async () => {
  await createProjectResourceGrant('P1', {
    resourceType: 'agent',
    resourceId: 'researcher',
    principalType: 'group',
    principalId: 'grp-1',
    expiresAt: null,
  });
  expect(last().body).toEqual({
    resource_type: 'agent',
    resource_id: 'researcher',
    principal_type: 'group',
    principal_id: 'grp-1',
    expires_at: null,
  });
});

test('deleteProjectResourceGrant deletes by grant id', async () => {
  await deleteProjectResourceGrant('P1', 'G9');
  expect(last().url).toContain('/projects/P1/resource-grants/G9');
  expect(last().method).toBe('DELETE');
});
