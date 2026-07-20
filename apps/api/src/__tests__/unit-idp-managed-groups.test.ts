/**
 * SCIM-sourced groups are OWNED BY THE IDP — sign-in group claims and
 * provisioning match by NAME, so a local rename orphans the group's grants
 * (the next sign-in auto-provisions a duplicate under the old name), and
 * local membership edits are silently clobbered by the IdP's next push.
 * The groups routes must 409 (code `group_idp_managed`) on those writes,
 * while description edits and same-name saves stay allowed, and manual
 * groups keep full local control.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../iam', () => ({
  ACCOUNT_ACTIONS: {
    GROUP_READ: 'group.read',
    GROUP_CREATE: 'group.create',
    GROUP_UPDATE: 'group.update',
    GROUP_DELETE: 'group.delete',
    GROUP_MEMBERS_MANAGE: 'group.members.manage',
  },
  assertAuthorized: async () => {},
}));

mock.module('../shared/audit', () => ({
  recordAuditEvent: async () => {},
}));

// Entitled account — these tests are about the IdP-managed guard, and a 402
// would fire before it.
mock.module('../billing/services/entitlements', () => ({
  accountHasEntitlement: async () => true,
}));

mock.module('../iam/cache-invalidation', () => ({
  invalidateIamCacheForGroup: async () => {},
  invalidateIamCacheForUser: () => {},
  invalidateIamCacheForUsers: () => {},
}));

const base = {
  accountId: 'acct-1',
  description: null as string | null,
  externalId: null as string | null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};
const scimGroup = { ...base, groupId: 'grp-scim', name: 'Engineers', source: 'scim' };
const manualGroup = { ...base, groupId: 'grp-manual', name: 'Ops', source: 'manual' };

mock.module('../repositories/iam', () => ({
  getGroup: async (_accountId: string, groupId: string) =>
    groupId === 'grp-scim' ? scimGroup : groupId === 'grp-manual' ? manualGroup : null,
  updateGroup: async (
    _accountId: string,
    groupId: string,
    patch: { name?: string; description?: string | null },
  ) => ({
    ...(groupId === 'grp-scim' ? scimGroup : manualGroup),
    ...patch,
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  }),
  addGroupMembers: async () => ({ added: 1 }),
  removeGroupMember: async () => true,
  createGroup: async () => manualGroup,
  deleteGroup: async () => true,
  listGroups: async () => [],
  listGroupMembers: async () => [],
}));

const { iamRouter } = await import('../accounts/iam/app');
await import('../accounts/iam/groups');

function buildApp() {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('userId', 'admin-1');
    await next();
  });
  app.route('/', iamRouter);
  return app;
}

const ACCOUNT = 'acct-1';
const jsonHeaders = { 'Content-Type': 'application/json' };

describe('SCIM group — rename is IdP-owned', () => {
  test('PATCH with a new name → 409 group_idp_managed', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-scim`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'Engineers-renamed' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('group_idp_managed');
  });

  test('PATCH description-only → 200 (locally editable)', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-scim`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ description: 'Platform engineers' }),
    });
    expect(res.status).toBe(200);
  });

  test('PATCH with the SAME name → 200 (no-op rename is not a rename)', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-scim`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'Engineers', description: 'unchanged name' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('SCIM group — membership is IdP-owned', () => {
  test('POST members → 409 group_idp_managed', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-scim/members`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ userIds: ['u-1'] }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('group_idp_managed');
  });

  test('DELETE member → 409 (a local remove is silently undone by the next push)', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-scim/members/u-1`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('group_idp_managed');
  });
});

describe('manual group — full local control retained', () => {
  test('PATCH rename → 200', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-manual`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'Ops-renamed' }),
    });
    expect(res.status).toBe(200);
  });

  test('POST members → 200', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-manual/members`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ userIds: ['u-1'] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(1);
  });

  test('DELETE member → 200', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/groups/grp-manual/members/u-1`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
  });
});
