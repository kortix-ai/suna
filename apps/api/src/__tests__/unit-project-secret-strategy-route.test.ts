import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSecrets } from '@kortix/db';
import { Hono } from 'hono';
import * as realAccess from '../projects/lib/access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SECRET_ID = '55555555-5555-4555-8555-555555555555';

const PROJECT_ACTIONS = {
  PROJECT_CONNECTOR_READ: 'project.connector.read',
  PROJECT_CONNECTOR_WRITE: 'project.connector.write',
  PROJECT_CUSTOMIZE_WRITE: 'project.customize.write',
  PROJECT_SECRET_READ: 'project.secret.read',
  PROJECT_SECRET_WRITE: 'project.secret.write',
};
mock.module('../iam', () => ({ PROJECT_ACTIONS }));

let agentGrant: Record<string, unknown> | null = null;
let authType: 'service_account' | 'supabase' = 'supabase';

let row: ReturnType<typeof secretRow> | null = secretRow();
const updates: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
const propagations: Array<{ projectId: string; options: unknown }> = [];

function secretRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-08-03T10:00:00.000Z');
  return {
    secretId: SECRET_ID,
    projectId: PROJECT_ID,
    identifier: 'SERVICE_API_KEY',
    name: 'SERVICE_API_KEY',
    valueEnc: 'encrypted-value',
    scope: 'runtime',
    ownerUserId: null,
    description: null,
    strategy: 'runtime' as const,
    egressPolicy: null,
    handlePrefix: null,
    rotatedAt: null,
    strategyLocked: false,
    active: true,
    createdBy: USER_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queryResult(fields: Record<string, unknown> | undefined) {
  if (!row) {
    return {
      limit: async () => [],
      orderBy: async () => [],
    };
  }
  const selected = fields
    ? {
        secretId: row.secretId,
        name: row.name,
        strategy: row.strategy,
        rotatedAt: row.rotatedAt,
        updatedAt: row.updatedAt,
        strategyLocked: row.strategyLocked,
      }
    : row;
  return {
    limit: async () => [selected],
    orderBy: async () => [selected],
  };
}

const databaseMock = {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table !== projectSecrets) throw new Error('unexpected table');
        return { where: () => queryResult(fields) };
      },
    }),
    update: (table: unknown) => {
      if (table !== projectSecrets) throw new Error('unexpected table');
      return {
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push(values);
            if (row) row = { ...row, ...values };
          },
        }),
      };
    },
    insert: (table: unknown) => {
      if (table !== projectSecrets) throw new Error('unexpected table');
      return {
        values: (values: Record<string, unknown>) => {
          const inserted = secretRow(values);
          row = inserted;
          return {
            onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => ({
              returning: async () => {
                row = row ? { ...row, ...set } : inserted;
                return [{ secretId: SECRET_ID }];
              },
            }),
          };
        },
      };
    },
    delete: (table: unknown) => {
      if (table !== projectSecrets) throw new Error('unexpected table');
      return {
        where: async () => {
          row = null;
        },
      };
    },
};

mock.module('../shared/db', () => ({ hasDatabase: true, db: databaseMock }));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: USER_ID,
    accountRole: 'owner',
    projectRole: 'owner',
    effectiveRole: 'owner',
    adminBypass: false,
  }),
  assertProjectCapability: async () => undefined,
}));

mock.module('../projects/lib/sandbox-env-sync', () => ({
  propagateProjectSecretsToActiveSandboxes: async (projectId: string, options: unknown) => {
    propagations.push({ projectId, options });
  },
}));

mock.module('../shared/audit', () => ({
  inferAuditSource: (_context: unknown, actorType: string) =>
    actorType === 'service_account' ? 'automation' : 'api',
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audits.push(event);
  },
  runAuditedTransaction: async <T>(
    operation: (tx: typeof databaseMock) => Promise<T>,
    event: (result: T) => Record<string, unknown>,
  ) => {
    const result = await operation(databaseMock);
    audits.push(event(result));
    return result;
  },
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/r3');

function buildApp() {
  const app = new Hono<{
    Variables: {
      userId: string;
      agentGrant: Record<string, unknown>;
      authType: 'service_account' | 'supabase';
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', authType);
    if (agentGrant) c.set('agentGrant', agentGrant);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

describe('PUT /v1/projects/:projectId/secrets/:identifier/strategy', () => {
  beforeEach(() => {
    row = secretRow();
    agentGrant = null;
    authType = 'supabase';
    updates.length = 0;
    audits.length = 0;
    propagations.length = 0;
  });

  test('changes runtime to denied and records metadata-only audit data', async () => {
    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'denied' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identifier: 'SERVICE_API_KEY',
      strategy: 'denied',
      delivery_status: 'disabled',
      requires_rotation: true,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.strategy).toBe('denied');
    expect(propagations).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      action: 'secret.strategy.changed',
      resourceType: 'project_secret',
      resourceId: SECRET_ID,
      before: { strategy: 'runtime' },
      after: { strategy: 'denied', requires_rotation: true },
      metadata: { identifier: 'SERVICE_API_KEY', name: 'SERVICE_API_KEY' },
    });
    expect(JSON.stringify(audits[0])).not.toContain('encrypted-value');
  });

  test.each(['broker', 'egress'] as const)(
    'rejects unavailable %s delivery without changing the row',
    async (strategy) => {
      const response = await buildApp().request(
        `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ strategy }),
        },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'secret_delivery_unavailable' });
      expect(updates).toHaveLength(0);
      expect(audits).toHaveLength(0);
    },
  );

  test('attributes a service-account strategy change to automation', async () => {
    authType = 'service_account';

    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'denied' }),
      },
    );

    expect(response.status).toBe(200);
    expect(audits[0]?.actorType).toBe('service_account');
    expect(audits[0]?.source).toBe('automation');
  });

  test('rejects an agent principal', async () => {
    agentGrant = { env: ['SERVICE_API_KEY'] };

    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'denied' }),
      },
    );

    expect(response.status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  test('rejects a locked strategy', async () => {
    row = secretRow({ strategyLocked: true });

    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'denied' }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'secret_strategy_locked' });
    expect(updates).toHaveLength(0);
  });

  test('rejects unexpected request fields', async () => {
    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'denied', value: 'not-accepted' }),
      },
    );

    expect(response.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  test('requires rotation before restoring runtime delivery', async () => {
    row = secretRow({
      strategy: 'denied',
      rotatedAt: new Date('2026-08-03T10:00:00.000Z'),
      updatedAt: new Date('2026-08-03T10:05:00.000Z'),
    });

    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'runtime' }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'secret_rotation_required' });
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test('restores runtime delivery after rotation', async () => {
    const rotatedAt = new Date('2026-08-03T10:05:00.000Z');
    row = secretRow({ strategy: 'denied', rotatedAt, updatedAt: rotatedAt });

    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'runtime' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'runtime',
      delivery_status: 'available',
      requires_rotation: false,
    });
    expect(updates).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});

describe('POST /v1/projects/:projectId/secrets audit', () => {
  beforeEach(() => {
    row = null;
    agentGrant = null;
    authType = 'supabase';
    updates.length = 0;
    audits.length = 0;
    propagations.length = 0;
  });

  test('records a metadata-only create event and marks the value rotated', async () => {
    const response = await buildApp().request(`/v1/projects/${PROJECT_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SERVICE_API_KEY', value: 'plaintext-test-value' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      identifier: 'SERVICE_API_KEY',
      strategy: 'runtime',
      delivery_status: 'available',
      last_rotated_at: expect.any(String),
      requires_rotation: false,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'secret.created',
      resourceType: 'project_secret',
      resourceId: SECRET_ID,
      before: null,
      after: { configured: true, strategy: 'runtime', rotated: true },
      metadata: { identifier: 'SERVICE_API_KEY', name: 'SERVICE_API_KEY' },
    });
    expect(JSON.stringify(audits[0])).not.toContain('plaintext-test-value');
  });
});

describe('DELETE /v1/projects/:projectId/secrets/:identifier audit', () => {
  beforeEach(() => {
    row = secretRow({
      identifier: 'primary-openai',
      name: 'OPENAI_API_KEY',
      valueEnc: 'encrypted-delete-value',
      strategy: 'denied',
    });
    agentGrant = null;
    authType = 'supabase';
    updates.length = 0;
    audits.length = 0;
    propagations.length = 0;
  });

  test('records the deleted policy metadata without the encrypted value', async () => {
    const response = await buildApp().request(
      `/v1/projects/${PROJECT_ID}/secrets/primary-openai`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'secret.deleted',
      resourceType: 'project_secret',
      resourceId: SECRET_ID,
      before: { configured: true, strategy: 'denied' },
      after: { configured: false },
      metadata: { identifier: 'primary-openai', name: 'OPENAI_API_KEY' },
    });
    expect(JSON.stringify(audits[0])).not.toContain('encrypted-delete-value');
    expect(propagations).toEqual([{
      projectId: PROJECT_ID,
      options: { refreshModels: true },
    }]);
  });
});
