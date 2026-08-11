import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { projectSecrets } from '@kortix/db';
import * as realAccess from '../workspaces/lib/access';

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const AUTHORIZED_USER_ID = '11111111-1111-4111-8111-111111111111';
const UNAUTHORIZED_USER_ID = '22222222-2222-4222-8222-222222222222';

const WORKSPACE_ACTIONS = {
  WORKSPACE_CONNECTOR_READ: 'project.connector.read',
  WORKSPACE_CONNECTOR_WRITE: 'project.connector.write',
  WORKSPACE_CUSTOMIZE_WRITE: 'project.customize.write',
  WORKSPACE_SECRET_READ: 'project.secret.read',
  WORKSPACE_SECRET_WRITE: 'project.secret.write',
};
mock.module('../iam', () => ({ WORKSPACE_ACTIONS }));

const deleteCalls: Array<{ table: unknown; where: unknown }> = [];
const propagateCalls: Array<{ workspaceId: string; opts: unknown }> = [];
const capabilityChecks: Array<{ userId: string; accountId: string; workspaceId: string; action: string }> = [];
const auditEvents: Array<Record<string, unknown>> = [];

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        deleteCalls.push({ table, where: cond });
        return Promise.resolve();
      },
    }),
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../workspaces/lib/access', () => ({
  ...realAccess,
  loadWorkspaceForUser: async (c: any) => ({
    row: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
    userId: c.get('userId'),
    accountRole: 'owner',
    projectRole: 'owner',
    effectiveRole: 'owner',
    adminBypass: false,
  }),
  assertWorkspaceCapability: async (_c: any, userId: string, accountId: string, workspaceId: string, action: string) => {
    capabilityChecks.push({ userId, accountId, workspaceId, action });
    if (userId !== AUTHORIZED_USER_ID) {
      throw new HTTPException(403, { message: 'You do not have access to this project' });
    }
  },
}));

mock.module('../workspaces/lib/sandbox-env-sync', () => ({
  propagateWorkspaceSecretsToActiveSandboxes: async (workspaceId: string, opts: unknown) => {
    propagateCalls.push({ workspaceId, opts });
  },
}));

mock.module('../shared/audit', () => ({
  inferAuditSource: () => 'api',
  recordAuditEvent: async (event: Record<string, unknown>) => {
    auditEvents.push(event);
  },
  runAuditedTransaction: async <T>(
    operation: (tx: typeof import('../shared/db').db) => Promise<T>,
    event: (result: T) => Record<string, unknown>,
  ) => {
    const result = await operation((await import('../shared/db')).db);
    auditEvents.push(event(result));
    return result;
  },
}));

const { workspaceRoutesApp: projectsApp } = await import('../workspaces/lib/app');
await import('../workspaces/routes/r3');

function buildApp(userId: string) {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: String(err) }, 500);
  });
  return app;
}

describe('DELETE /v1/projects/:workspaceId/oauth/:provider', () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    propagateCalls.length = 0;
    capabilityChecks.length = 0;
    auditEvents.length = 0;
  });

  test('authorized principal deletes the backing secret and propagates to sandboxes', async () => {
    const res = await buildApp(AUTHORIZED_USER_ID).request(`/v1/projects/${WORKSPACE_ID}/oauth/openai`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(capabilityChecks).toHaveLength(1);
    expect(capabilityChecks[0]).toMatchObject({
      userId: AUTHORIZED_USER_ID,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      action: WORKSPACE_ACTIONS.WORKSPACE_CONNECTOR_WRITE,
    });

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].table).toBe(projectSecrets);

    expect(propagateCalls).toHaveLength(1);
    expect(propagateCalls[0].workspaceId).toBe(WORKSPACE_ID);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: 'secret.oauth.disconnected',
      workspaceId: WORKSPACE_ID,
      metadata: {
        identifier: 'CODEX_AUTH_JSON',
        consumer: 'llm_gateway',
      },
    });
  });

  test('unauthorized principal is denied and no delete is issued', async () => {
    const res = await buildApp(UNAUTHORIZED_USER_ID).request(`/v1/projects/${WORKSPACE_ID}/oauth/openai`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    expect(capabilityChecks).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    expect(propagateCalls).toHaveLength(0);
  });

  test('unknown provider → 404 before any capability side effect', async () => {
    const res = await buildApp(AUTHORIZED_USER_ID).request(`/v1/projects/${WORKSPACE_ID}/oauth/not-a-real-provider`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect(deleteCalls).toHaveLength(0);
  });
});
