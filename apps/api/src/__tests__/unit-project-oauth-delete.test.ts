import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { projectSecrets } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as realAccess from '../projects/lib/access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const AUTHORIZED_USER_ID = '11111111-1111-4111-8111-111111111111';
const UNAUTHORIZED_USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_MEMBER_USER_ID = '55555555-5555-4555-8555-555555555555';

const PROJECT_ACTIONS = {
  PROJECT_CONNECTOR_READ: 'project.connector.read',
  PROJECT_CONNECTOR_WRITE: 'project.connector.write',
  PROJECT_CUSTOMIZE_WRITE: 'project.customize.write',
  PROJECT_SECRET_READ: 'project.secret.read',
  PROJECT_SECRET_WRITE: 'project.secret.write',
};
mock.module('../iam', () => ({ PROJECT_ACTIONS }));

const deleteCalls: Array<{ table: unknown; where: unknown }> = [];
const propagateCalls: Array<{ projectId: string; opts: unknown }> = [];
const capabilityChecks: Array<{ userId: string; accountId: string; projectId: string; action: string }> = [];
const auditEvents: Array<Record<string, unknown>> = [];
// The caller's project role label. `roleAllows(role, 'manage')` is true only
// for 'manager'; the GET secrets route uses the same test for `canManageShared`.
let effectiveRole: 'manager' | 'member' = 'manager';

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
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (c: any) => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: c.get('userId'),
    accountRole: 'owner',
    projectRole: effectiveRole,
    effectiveRole,
    adminBypass: false,
  }),
  assertProjectCapability: async (_c: any, userId: string, accountId: string, projectId: string, action: string) => {
    capabilityChecks.push({ userId, accountId, projectId, action });
    if (userId !== AUTHORIZED_USER_ID) {
      throw new HTTPException(403, { message: 'You do not have access to this project' });
    }
  },
}));

mock.module('../projects/lib/sandbox-env-sync', () => ({
  propagateProjectSecretsToActiveSandboxes: async (projectId: string, opts: unknown) => {
    propagateCalls.push({ projectId, opts });
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

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/r3');

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

describe('DELETE /v1/projects/:projectId/oauth/:provider', () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    propagateCalls.length = 0;
    capabilityChecks.length = 0;
    auditEvents.length = 0;
    effectiveRole = 'manager';
  });

  test('authorized principal deletes the backing secret and propagates to sandboxes', async () => {
    const res = await buildApp(AUTHORIZED_USER_ID).request(`/v1/projects/${PROJECT_ID}/oauth/openai`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(capabilityChecks).toHaveLength(1);
    expect(capabilityChecks[0]).toMatchObject({
      userId: AUTHORIZED_USER_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      action: PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
    });

    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].table).toBe(projectSecrets);

    expect(propagateCalls).toHaveLength(1);
    expect(propagateCalls[0].projectId).toBe(PROJECT_ID);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: 'secret.oauth.disconnected',
      projectId: PROJECT_ID,
      metadata: {
        identifier: 'CODEX_AUTH_JSON',
        consumer: 'llm_gateway',
        scope: 'own_private_and_shared',
      },
    });
  });

  // The web counts a legacy OPENCODE_AUTH_JSON row as a connected ChatGPT
  // subscription and offers "Disconnect ChatGPT" over it. This route deleted
  // only CODEX_AUTH_JSON, returned 200, and left the legacy row in place, so
  // such a project could never be disconnected from the product.
  test('openai disconnect also deletes the legacy OPENCODE_AUTH_JSON credential', async () => {
    const res = await buildApp(AUTHORIZED_USER_ID).request(`/v1/projects/${PROJECT_ID}/oauth/openai`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(deleteCalls).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(deleteCalls[0].where as any);
    expect(params).toContain(PROJECT_ID);
    expect(params).toContain('CODEX_AUTH_JSON');
    expect(params).toContain('OPENCODE_AUTH_JSON');
    expect(sql).toContain('"project_id" = ');
  });

  // CODEX_AUTH_JSON / OPENCODE_AUTH_JSON can be per-user PRIVATE rows
  // (`owner_user_id` set). The delete used to filter on project + name only, so
  // one member's disconnect also deleted every other member's private login.
  // The delete must cover exactly the rows the caller sees as "connected": the
  // caller's own private rows, plus the shared row when the caller may manage it.
  describe('owner scoping', () => {
    async function disconnect() {
      const res = await buildApp(AUTHORIZED_USER_ID).request(`/v1/projects/${PROJECT_ID}/oauth/openai`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(deleteCalls).toHaveLength(1);
      return new PgDialect().sqlToQuery(deleteCalls[0].where as any);
    }

    test("keeps another member's private row: every delete branch is bound to the caller or to the shared row", async () => {
      const { sql, params } = await disconnect();
      expect(params).not.toContain(OTHER_MEMBER_USER_ID);
      // No unscoped branch: the owner column is constrained in the WHERE clause.
      expect(sql).toMatch(/"owner_user_id" = \$\d+/);
      expect(sql).toMatch(/\(.*"owner_user_id" = \$\d+ or .*"owner_user_id" is null\)/);
    });

    test("deletes the caller's own private row", async () => {
      const { sql, params } = await disconnect();
      expect(params).toContain(AUTHORIZED_USER_ID);
      const ownerParamIndex = params.indexOf(AUTHORIZED_USER_ID) + 1;
      expect(sql).toContain(`"owner_user_id" = $${ownerParamIndex}`);
    });

    test('deletes the shared row when the caller can manage shared secrets', async () => {
      effectiveRole = 'manager';
      const { sql } = await disconnect();
      expect(sql).toContain('"owner_user_id" is null');
      expect(auditEvents[0]).toMatchObject({ metadata: { scope: 'own_private_and_shared' } });
    });

    test('keeps the shared row when the caller cannot manage shared secrets', async () => {
      effectiveRole = 'member';
      const { sql, params } = await disconnect();
      expect(sql).not.toContain('is null');
      expect(params).toContain(AUTHORIZED_USER_ID);
      expect(auditEvents[0]).toMatchObject({ metadata: { scope: 'own_private' } });
    });

    test('legacy OPENCODE_AUTH_JSON follows the same owner scoping', async () => {
      const { sql, params } = await disconnect();
      expect(params).toContain('CODEX_AUTH_JSON');
      expect(params).toContain('OPENCODE_AUTH_JSON');
      expect(params).toContain(AUTHORIZED_USER_ID);
      expect(params).not.toContain(OTHER_MEMBER_USER_ID);
      // The name filter and the owner filter are ANDed, so the owner scope binds
      // both names; there is no per-name branch that skips it.
      expect(sql).toMatch(/"name" in \(\$\d+, \$\d+\) and \(/);
    });
  });

  test('unauthorized principal is denied and no delete is issued', async () => {
    const res = await buildApp(UNAUTHORIZED_USER_ID).request(`/v1/projects/${PROJECT_ID}/oauth/openai`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
    expect(capabilityChecks).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    expect(propagateCalls).toHaveLength(0);
  });

  test('unknown provider → 404 before any capability side effect', async () => {
    const res = await buildApp(AUTHORIZED_USER_ID).request(`/v1/projects/${PROJECT_ID}/oauth/not-a-real-provider`, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect(deleteCalls).toHaveLength(0);
  });
});
