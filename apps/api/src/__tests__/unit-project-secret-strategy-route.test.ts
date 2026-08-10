import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { connectors, projectSecrets, projectSessionSecretHandles } from '@kortix/db';
import { Hono } from 'hono';
import * as realAccess from '../workspaces/lib/access';

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SECRET_ID = '55555555-5555-4555-8555-555555555555';

const WORKSPACE_ACTIONS = {
  WORKSPACE_CONNECTOR_READ: 'project.connector.read',
  WORKSPACE_CONNECTOR_WRITE: 'project.connector.write',
  WORKSPACE_CUSTOMIZE_WRITE: 'project.customize.write',
  WORKSPACE_SECRET_READ: 'project.secret.read',
  WORKSPACE_SECRET_WRITE: 'project.secret.write',
};
mock.module('../iam', () => ({ WORKSPACE_ACTIONS }));

let agentGrant: Record<string, unknown> | null = null;
let authType: 'service_account' | 'supabase' = 'supabase';

let row: ReturnType<typeof secretRow> | null = secretRow();
const updates: Array<Record<string, unknown>> = [];
const handleUpdates: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
const propagations: Array<{ workspaceId: string; options: unknown }> = [];
const boundConnectorSlugs: string[] = [];

function secretRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-08-03T10:00:00.000Z');
  return {
    secretId: SECRET_ID,
    workspaceId: WORKSPACE_ID,
    identifier: 'SERVICE_API_KEY',
    name: 'SERVICE_API_KEY',
    valueEnc: 'encrypted-value',
    scope: 'runtime',
    ownerUserId: null,
    description: null,
    strategy: 'runtime' as const,
    consumer: 'sandbox' as const,
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
        consumer: row.consumer,
        rotatedAt: row.rotatedAt,
        updatedAt: row.updatedAt,
        strategyLocked: row.strategyLocked,
        egressPolicy: row.egressPolicy,
        handlePrefix: row.handlePrefix,
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
      if (table === connectors) {
        return { where: async () => boundConnectorSlugs.map((slug) => ({ slug })) };
      }
      if (table !== projectSecrets) throw new Error('unexpected table');
      return { where: () => queryResult(fields) };
    },
  }),
  update: (table: unknown) => {
    if (table === projectSessionSecretHandles) {
      return {
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            handleUpdates.push(values);
          },
        }),
      };
    }
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
mock.module('../workspaces/lib/access', () => ({
  ...realAccess,
  loadWorkspaceForUser: async () => ({
    row: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
    userId: USER_ID,
    accountRole: 'owner',
    projectRole: 'owner',
    effectiveRole: 'owner',
    adminBypass: false,
  }),
  assertWorkspaceCapability: async () => undefined,
}));

mock.module('../workspaces/lib/sandbox-env-sync', () => ({
  propagateWorkspaceSecretsToActiveSandboxes: async (workspaceId: string, options: unknown) => {
    propagations.push({ workspaceId, options });
  },
}));

mock.module('../secrets/network-boundary-availability', () => ({
  networkBoundaryDeliveryAvailable: () => true,
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

const { workspaceRoutesApp: projectsApp } = await import('../workspaces/lib/app');
await import('../workspaces/routes/r3');

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

describe('PUT /v1/projects/:workspaceId/secrets/:identifier/strategy', () => {
  beforeEach(() => {
    row = secretRow();
    agentGrant = null;
    authType = 'supabase';
    updates.length = 0;
    handleUpdates.length = 0;
    audits.length = 0;
    propagations.length = 0;
    boundConnectorSlugs.length = 0;
  });

  test('changes runtime to denied and records metadata-only audit data', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
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
    expect(handleUpdates).toEqual([
      expect.objectContaining({ status: 'revoked', revokedAt: expect.any(Date) }),
    ]);
    expect(propagations).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
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

  test('requires an outbound policy for broker delivery', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'broker' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'secret_delivery_policy_required' });
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test('configures the generic HTTPS broker with a validated outbound policy', async () => {
    const egressPolicy = {
      backend: 'kortix_fetch',
      rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
      inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
    };
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy: 'broker',
          egress_policy: egressPolicy,
          handle_prefix: 'svc_',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'broker',
      consumer: 'http_broker',
      delivery_status: 'available',
      egress_policy: egressPolicy,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      strategy: 'broker',
      egressPolicy,
      handlePrefix: 'svc_',
    });
    expect(audits).toHaveLength(1);
  });

  test('rejects a network policy on the LLM gateway consumer', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy: 'broker',
          egress_policy: {
            backend: 'llm_gateway',
            rules: [{ host: 'api.example.com' }],
            inject: { kind: 'header', name: 'authorization' },
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  test('configures the LLM gateway without a network policy', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'broker', consumer: 'llm_gateway' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'broker',
      consumer: 'llm_gateway',
      delivery_status: 'available',
      egress_policy: null,
    });
    expect(updates[0]).toMatchObject({
      strategy: 'broker',
      consumer: 'llm_gateway',
      egressPolicy: null,
    });
  });

  test('configures a connector consumer without a network policy', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'broker', consumer: 'connector' }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'broker',
      consumer: 'connector',
      delivery_status: 'available',
      egress_policy: null,
    });
    expect(updates[0]).toMatchObject({
      strategy: 'broker',
      consumer: 'connector',
      egressPolicy: null,
    });
  });

  test('rejects leaving connector delivery while a connector is bound', async () => {
    row = secretRow({ strategy: 'broker', consumer: 'connector' });
    boundConnectorSlugs.push('binding-postman-echo');

    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'denied' }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Remove connector bindings before changing this secret delivery policy',
      code: 'secret_connector_binding_exists',
      connectors: ['binding-postman-echo'],
    });
    expect(updates).toHaveLength(0);
  });

  test('rejects removed secret consumer values', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'broker', consumer: 'executor' }),
      },
    );

    expect(response.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  test('stores an enforceable network-boundary policy', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy: 'egress',
          egress_policy: {
            rules: [{ host: 'api.example.com' }],
            inject: {
              kind: 'header',
              name: 'authorization',
              template: 'Bearer {{secret}}',
            },
            on_no_match: 'deny',
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'egress',
      consumer: 'network',
      delivery_status: 'available',
    });
    expect(updates).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  test('rejects a network policy whose method restriction cannot be enforced', async () => {
    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy: 'egress',
          egress_policy: {
            rules: [{ host: 'api.example.com', methods: ['POST'] }],
            inject: { kind: 'header', name: 'authorization' },
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'secret_delivery_policy_invalid' });
    expect(updates).toHaveLength(0);
  });

  test('attributes a service-account strategy change to automation', async () => {
    authType = 'service_account';

    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
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
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
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
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
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
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
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
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
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
      `/v1/projects/${WORKSPACE_ID}/secrets/SERVICE_API_KEY/strategy`,
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

describe('POST /v1/projects/:workspaceId/secrets audit', () => {
  beforeEach(() => {
    row = null;
    agentGrant = null;
    authType = 'supabase';
    updates.length = 0;
    handleUpdates.length = 0;
    audits.length = 0;
    propagations.length = 0;
    boundConnectorSlugs.length = 0;
  });

  test('records a metadata-only create event and marks the value rotated', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
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

  test('infers the sandbox consumer for explicit runtime creation', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'runtime',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'runtime',
      consumer: 'sandbox',
    });
    expect(row).toMatchObject({ strategy: 'runtime', consumer: 'sandbox' });
  });

  test('infers no consumer for explicit denied creation', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'denied',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'denied',
      consumer: null,
    });
    expect(row).toMatchObject({ strategy: 'denied', consumer: null });
  });

  test('creates an enforceable network-boundary secret', async () => {
    const policy = {
      rules: [{ host: 'api.example.com' }],
      inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
      on_no_match: 'deny',
      tls: 'terminate',
    };
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'egress',
        consumer: 'network',
        egress_policy: policy,
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'egress',
      consumer: 'network',
      delivery_status: 'available',
      egress_policy: policy,
    });
    expect(row).toMatchObject({ strategy: 'egress', consumer: 'network', egressPolicy: policy });
  });

  test('rejects a creation consumer without a strategy', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        consumer: 'sandbox',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'consumer requires a strategy' });
  });

  test('rejects consumers that conflict with runtime or denied creation', async () => {
    const app = buildApp();
    const runtime = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'runtime',
        consumer: 'connector',
      }),
    });
    const denied = await app.request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'denied',
        consumer: 'sandbox',
      }),
    });

    expect(runtime.status).toBe(400);
    expect(denied.status).toBe(400);
  });

  test('requires a named server consumer for broker creation', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'broker',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'broker creation requires a supported server consumer',
    });
  });

  test('creates an LLM gateway secret without a runtime delivery transition', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'broker',
        consumer: 'llm_gateway',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'broker',
      consumer: 'llm_gateway',
      delivery_status: 'available',
      egress_policy: null,
    });
    expect(row).toMatchObject({ strategy: 'broker', consumer: 'llm_gateway' });
    expect(audits[0]).toMatchObject({
      after: {
        configured: true,
        strategy: 'broker',
        consumer: 'llm_gateway',
        rotated: true,
      },
    });
    expect(JSON.stringify(audits)).not.toContain('plaintext-test-value');
  });

  test('defaults a known LLM credential to the LLM gateway', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ANTHROPIC_API_KEY', value: 'plaintext-test-value' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'broker',
      consumer: 'llm_gateway',
      delivery_status: 'available',
    });
    expect(row).toMatchObject({ strategy: 'broker', consumer: 'llm_gateway' });
    expect(audits[0]).toMatchObject({
      after: {
        configured: true,
        strategy: 'broker',
        consumer: 'llm_gateway',
        rotated: true,
      },
    });
  });

  test('keeps an explicit runtime choice for a known LLM credential', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'ANTHROPIC_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'runtime',
        consumer: 'sandbox',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'runtime',
      consumer: 'sandbox',
    });
    expect(row).toMatchObject({ strategy: 'runtime', consumer: 'sandbox' });
  });

  test('creates a connector secret without a runtime delivery transition', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'SERVICE_API_KEY',
        value: 'plaintext-test-value',
        strategy: 'broker',
        consumer: 'connector',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: 'broker',
      consumer: 'connector',
      delivery_status: 'available',
      egress_policy: null,
    });
    expect(row).toMatchObject({ strategy: 'broker', consumer: 'connector' });
    expect(JSON.stringify(audits)).not.toContain('plaintext-test-value');
  });
});

describe('DELETE /v1/projects/:workspaceId/secrets/:identifier audit', () => {
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
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets/primary-openai`, {
      method: 'DELETE',
    });

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
    expect(propagations).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        options: { refreshModels: true },
      },
    ]);
  });

  test('requires the OAuth disconnect route for a Codex credential', async () => {
    row = secretRow({
      identifier: 'CODEX_AUTH_JSON',
      name: 'CODEX_AUTH_JSON',
      strategy: 'broker',
      consumer: 'llm_gateway',
    });

    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/CODEX_AUTH_JSON`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(400);
    expect(row).not.toBeNull();
    expect(audits).toHaveLength(0);
  });

  test('rejects deletion while a connector is bound', async () => {
    row = secretRow({
      identifier: 'POSTMAN_ECHO_TOKEN',
      name: 'POSTMAN_ECHO_TOKEN',
      strategy: 'broker',
      consumer: 'connector',
    });
    boundConnectorSlugs.push('binding-postman-echo');

    const response = await buildApp().request(
      `/v1/projects/${WORKSPACE_ID}/secrets/POSTMAN_ECHO_TOKEN`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Remove connector bindings before deleting this secret',
      code: 'secret_connector_binding_exists',
      connectors: ['binding-postman-echo'],
    });
    expect(row).not.toBeNull();
    expect(audits).toHaveLength(0);
  });
});

describe('DELETE /v1/projects/:workspaceId/oauth/:provider audit', () => {
  beforeEach(() => {
    row = secretRow({
      identifier: 'CODEX_AUTH_JSON',
      name: 'CODEX_AUTH_JSON',
      strategy: 'broker',
      consumer: 'llm_gateway',
    });
    agentGrant = null;
    authType = 'supabase';
    audits.length = 0;
    propagations.length = 0;
  });

  test('deletes subscription credentials and records metadata only', async () => {
    const response = await buildApp().request(`/v1/projects/${WORKSPACE_ID}/oauth/openai`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(row).toBeNull();
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'secret.oauth.disconnected',
        resourceType: 'project_secret',
        metadata: {
          identifier: 'CODEX_AUTH_JSON',
          consumer: 'llm_gateway',
        },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain('encrypted-value');
  });
});
