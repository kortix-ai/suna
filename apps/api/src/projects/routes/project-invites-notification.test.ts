import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const app = new OpenAPIHono();
let rejectDelivery: (reason: Error) => void = () => {};
const delivery = new Promise<never>((_resolve, reject) => { rejectDelivery = reject; });
const notify = mock(() => delivery);
const warn = mock(() => {});
const grant = mock(async () => {});
mock.module('../lib/app', () => ({ projectsApp: app }));
mock.module('../../accounts/email', () => ({
  sendProjectAddedEmail: notify,
  sendAccountInviteEmail: mock(async () => ({ ok: true })),
  buildInviteUrl: () => '/invites/synthetic',
  isInviteEmailConfigured: () => true,
}));
mock.module('../../lib/logger', () => ({ logger: { warn } }));
mock.module('../../shared/db', () => ({ db: {} }));
mock.module('../../iam/account-identity', () => ({
  resolveAccountIdentityByEmail: async () => ({ userId: 'synthetic-user', ambiguous: false }),
}));
mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({ userId: 'synthetic-owner', row: { accountId: 'synthetic-account', name: 'Synthetic project' } }),
  assertProjectCapability: async () => {},
  parseExpiresAtBody: () => ({ ok: true, value: null }),
  ensureOrgMembership: async () => 'member',
  grantProjectRole: grant,
  lookupEmailsByUserIds: async () => ({}),
}));
const { registerProjectInvitesRoutes } = await import('./project-invites');
registerProjectInvitesRoutes();

test('existing-user invite responds before provider settles and handles later rejection', async () => {
  const request = app.request('/synthetic-project/access/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'member@example.test', role: 'member' }),
  });
  const pending = Symbol('provider still pending');
  // One event-loop turn is enough for the mocked authorization/grant chain;
  // no provider timeout or wall-clock sleep is involved.
  const result = await Promise.race([request, new Promise<typeof pending>((resolve) => setImmediate(() => resolve(pending)))]);
  try {
    expect(result).not.toBe(pending);
    if (result === pending) return;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ project_role: 'member', has_implicit_access: false });
    expect(grant).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    rejectDelivery(new Error('synthetic provider failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await request;
  }
  expect(warn).toHaveBeenCalledTimes(1);
});
