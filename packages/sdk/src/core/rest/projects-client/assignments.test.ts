// The canonical assignment surface — ONE grant table, ONE write path.
//
// These tests pin the wire contract of `/accounts/:id/iam/assignments` and
// `/accounts/:id/iam/permissions`. They exist because the five shapes this
// replaces (`PUT /access/:userId`, `POST /group-grants`, `POST /iam/policies`,
// `POST /resource-grants`, `PATCH /members/:uid`) each encoded the principal,
// the scope and the expiry differently, and the client had to know which.

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  createAssignment,
  listAssignments,
  listPermissions,
  revokeAssignment,
  type Permission,
  type RoleAssignment,
} from './assignments';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };
let reportedErrors = 0;

beforeEach(() => {
  calls = [];
  reportedErrors = 0;
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
  configureKortix({
    backendUrl: 'http://test.local',
    getToken: async () => 'tok',
    onError: () => {
      reportedErrors += 1;
    },
  });
});

const last = () => calls[calls.length - 1];

const row: RoleAssignment = {
  assignment_id: 'as-1',
  account_id: 'acc-1',
  principal_type: 'user',
  principal_id: 'u-1',
  role_id: 'role-1',
  role_key: 'member',
  role_is_system: true,
  scope_type: 'project',
  scope_id: 'proj-1',
  object_type: null,
  object_id: null,
  expires_at: null,
  granted_by: 'u-owner',
  source: 'manual',
  created_at: '2026-08-19T00:00:00.000Z',
  updated_at: '2026-08-19T00:00:00.000Z',
};

// ── list ────────────────────────────────────────────────────────────────────

test('listAssignments GETs the account assignment collection and unwraps it', async () => {
  nextResponse = { status: 200, body: { assignments: [row] } };
  const out = await listAssignments('acc-1');
  expect(last().method).toBe('GET');
  expect(last().url).toContain('/accounts/acc-1/iam/assignments');
  expect(out).toEqual([row]);
});

test('listAssignments sends principal_type and principal_id together as query params', async () => {
  nextResponse = { status: 200, body: { assignments: [] } };
  await listAssignments('acc-1', { principalType: 'group', principalId: 'g-1' });
  const url = new URL(last().url);
  expect(url.searchParams.get('principal_type')).toBe('group');
  expect(url.searchParams.get('principal_id')).toBe('g-1');
});

test('listAssignments maps scope, object and role filters onto snake_case params', async () => {
  nextResponse = { status: 200, body: { assignments: [] } };
  await listAssignments('acc-1', {
    scopeType: 'project',
    scopeId: 'proj-1',
    objectType: 'agent',
    objectId: 'reviewer',
    roleId: 'role-9',
    includeExpired: true,
  });
  const url = new URL(last().url);
  expect(url.searchParams.get('scope_type')).toBe('project');
  expect(url.searchParams.get('scope_id')).toBe('proj-1');
  expect(url.searchParams.get('object_type')).toBe('agent');
  expect(url.searchParams.get('object_id')).toBe('reviewer');
  expect(url.searchParams.get('role_id')).toBe('role-9');
  expect(url.searchParams.get('include_expired')).toBe('true');
});

test('listAssignments omits every filter it was not given', async () => {
  nextResponse = { status: 200, body: { assignments: [] } };
  await listAssignments('acc-1');
  expect(last().url).toBe('http://test.local/accounts/acc-1/iam/assignments');
});

test('listAssignments is a background read — a 403 never reaches the global error sink', async () => {
  nextResponse = { status: 403, body: { message: 'forbidden' } };
  await listAssignments('acc-1').catch(() => undefined);
  expect(reportedErrors).toBe(0);
});

// ── create ──────────────────────────────────────────────────────────────────

test('createAssignment POSTs ONE row — principal, role, scope — and returns it', async () => {
  nextResponse = { status: 201, body: row };
  const out = await createAssignment('acc-1', {
    principal: { type: 'user', id: 'u-1' },
    roleId: 'role-1',
    scope: { type: 'project', id: 'proj-1' },
  });
  expect(last().method).toBe('POST');
  expect(last().url).toContain('/accounts/acc-1/iam/assignments');
  expect(last().body).toEqual({
    principal_type: 'user',
    principal_id: 'u-1',
    role_id: 'role-1',
    scope_type: 'project',
    scope_id: 'proj-1',
  });
  expect(out).toEqual(row);
});

test('createAssignment accepts a role KEY instead of an id, for portable built-ins', async () => {
  nextResponse = { status: 201, body: row };
  await createAssignment('acc-1', {
    principal: { type: 'user', id: 'u-1' },
    roleKey: 'manager',
    scope: { type: 'project', id: 'proj-1' },
  });
  expect(last().body).toMatchObject({ role_key: 'manager' });
  expect((last().body as Record<string, unknown>).role_id).toBeUndefined();
});

test('createAssignment sends scope_id null for an account-scoped assignment', async () => {
  nextResponse = { status: 201, body: { ...row, scope_type: 'account', scope_id: null } };
  await createAssignment('acc-1', {
    principal: { type: 'user', id: 'u-1' },
    roleKey: 'admin',
    scope: { type: 'account' },
  });
  expect(last().body).toMatchObject({ scope_type: 'account', scope_id: null });
});

test('createAssignment carries object_type + object_id for an object grant', async () => {
  nextResponse = { status: 201, body: { ...row, object_type: 'agent', object_id: 'reviewer' } };
  await createAssignment('acc-1', {
    principal: { type: 'user', id: 'u-1' },
    roleKey: 'agent-user',
    scope: { type: 'project', id: 'proj-1' },
    object: { type: 'agent', id: 'reviewer' },
  });
  expect(last().body).toMatchObject({ object_type: 'agent', object_id: 'reviewer' });
});

test('createAssignment sends expires_at only when supplied, and null clears it explicitly', async () => {
  nextResponse = { status: 201, body: row };
  await createAssignment('acc-1', {
    principal: { type: 'user', id: 'u-1' },
    roleKey: 'member',
    scope: { type: 'project', id: 'proj-1' },
  });
  expect((last().body as Record<string, unknown>).expires_at).toBeUndefined();

  await createAssignment('acc-1', {
    principal: { type: 'user', id: 'u-1' },
    roleKey: 'member',
    scope: { type: 'project', id: 'proj-1' },
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  expect((last().body as Record<string, unknown>).expires_at).toBe('2027-01-01T00:00:00.000Z');

  await createAssignment('acc-1', {
    principal: { type: 'user', id: 'u-1' },
    roleKey: 'member',
    scope: { type: 'project', id: 'proj-1' },
    expiresAt: null,
  });
  expect((last().body as Record<string, unknown>).expires_at).toBeNull();
});

// ── revoke ──────────────────────────────────────────────────────────────────

test('revokeAssignment DELETEs one assignment by id and returns the removed row', async () => {
  nextResponse = { status: 200, body: { revoked: true, assignment: row } };
  const out = await revokeAssignment('acc-1', 'as-1');
  expect(last().method).toBe('DELETE');
  expect(last().url).toContain('/accounts/acc-1/iam/assignments/as-1');
  expect(out).toEqual(row);
});

// ── permission catalog ──────────────────────────────────────────────────────

const permission: Permission = {
  action: 'project.secret.read',
  scope_type: 'project',
  resource_type: 'project',
  delegable: true,
  description: 'Read project secrets',
  area: 'Secrets',
  level: 'view',
  implies: [],
};

test('listPermissions GETs the catalog and unwraps `permissions`', async () => {
  nextResponse = { status: 200, body: { permissions: [permission] } };
  const out = await listPermissions('acc-1');
  expect(last().method).toBe('GET');
  expect(last().url).toContain('/accounts/acc-1/iam/permissions');
  expect(out).toEqual([permission]);
});

test('listPermissions narrows to one scope when asked', async () => {
  nextResponse = { status: 200, body: { permissions: [] } };
  await listPermissions('acc-1', { scopeType: 'account' });
  expect(new URL(last().url).searchParams.get('scope_type')).toBe('account');
});

test('listPermissions is a background read — a 403 never reaches the global error sink', async () => {
  nextResponse = { status: 403, body: { message: 'forbidden' } };
  await listPermissions('acc-1').catch(() => undefined);
  expect(reportedErrors).toBe(0);
});
