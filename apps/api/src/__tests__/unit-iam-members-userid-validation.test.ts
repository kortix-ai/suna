// KRTX-4373: a non-UUID {userId} on the per-member IAM routes used to reach a
// `::uuid` cast (SQLSTATE 22P02) and answer 500. It must answer 400.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const CALLER_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_ID = '00000000-0000-4000-a000-000000000002';

let asserted: string[] = [];
let denyAll = false;
let probed: string[] = [];

mock.module('../iam', () => ({
  ACCOUNT_ACTIONS: {
    MEMBER_READ: 'member.read',
    MEMBER_SUPER_ADMIN_GRANT: 'member.super_admin.grant',
  },
  assertAuthorized: async (_actor: unknown, action: string) => {
    asserted.push(action);
    if (denyAll) throw new HTTPException(403, { message: `denied:${action}` });
  },
  authorize: async () => ({ allowed: true }),
  resourceTypeForAction: () => 'account',
  // members.ts names each probed action by its workspace name too.
  toWorkspaceAction: (action: string) => action,
}));
mock.module('../iam/actor', () => ({
  actorOf: async () => ({ userId: CALLER_ID, accountId: ACCOUNT_ID }),
  actorForUser: async (userId: string) => {
    probed.push(userId);
    return { userId, accountId: ACCOUNT_ID };
  },
}));

const { iamRouter } = await import('../accounts/iam/app');
(await import('../accounts/iam/members')).registerIamMembersRoutes();

function createApp() {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    c.set('userId' as never, CALLER_ID as never);
    await next();
  });
  app.route('/v1/accounts', iamRouter);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: (err as Error).message }, 500);
  });
  return app;
}

const base = `/v1/accounts/${ACCOUNT_ID}/iam/members`;
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const patch = (body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('per-member IAM routes validate {userId}', () => {
  beforeEach(() => {
    asserted = [];
    denyAll = false;
    probed = [];
  });

  test('GET effective with a non-UUID member id is a 400 and never builds an actor', async () => {
    const res = await createApp().request(`${base}/x/effective?action=project.read`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'userId must be a UUID' });
    expect(probed).toEqual([]);
  });

  test('GET effective with a UUID member id still probes that member', async () => {
    const res = await createApp().request(`${base}/${OTHER_ID}/effective?action=project.read`);
    expect(res.status).toBe(200);
    expect(probed).toEqual([OTHER_ID]);
  });

  test('effective:batch, groups, project-access and super-admin reject a non-UUID id with 400', async () => {
    const app = createApp();
    expect((await app.request(`${base}/x/effective:batch`, post({ probes: [] }))).status).toBe(400);
    expect((await app.request(`${base}/x/groups`)).status).toBe(400);
    expect((await app.request(`${base}/x/project-access`)).status).toBe(400);
    expect(
      (await app.request(`${base}/x/super-admin`, patch({ is_super_admin: true }))).status,
    ).toBe(400);
  });

  test('authorization runs first: a caller without member.read gets 403, not a UUID hint', async () => {
    denyAll = true;
    const res = await createApp().request(`${base}/x/effective?action=project.read`);
    expect(res.status).toBe(403);
    expect(asserted).toEqual(['member.read']);
  });
});
