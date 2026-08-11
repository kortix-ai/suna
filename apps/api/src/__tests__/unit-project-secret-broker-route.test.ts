import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSecrets, projectSessionSecretHandles, projectSessions } from '@kortix/db';
import { Hono } from 'hono';
import * as realAccess from '../workspaces/lib/access';
import * as realWorkspaceSecrets from '../workspaces/secrets';

const WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const SECRET_ID = '66666666-6666-4666-8666-666666666666';
const POLICY = {
  backend: 'kortix_fetch' as const,
  rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
  inject: { kind: 'header' as const, name: 'authorization', template: 'Bearer {{secret}}' },
};
const FROZEN_POLICY = {
  backend: 'kortix_fetch' as const,
  rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
  inject: { kind: 'header' as const, name: 'x-api-key' },
};

let authType: 'pat' | 'supabase' = 'pat';
let tokenWorkspaceId: string | undefined = WORKSPACE_ID;
let sessionId: string | undefined = SESSION_ID;
let agentGrant: Record<string, unknown> | null = {
  agent: 'default',
  kortixCli: 'all',
  connectors: 'all',
  env: ['PRIMARY'],
};
let sessionRow: Record<string, unknown> | null = {
  sessionId: SESSION_ID,
  secretsAllowlist: ['PRIMARY'],
};
let handleRow: Record<string, unknown> | null = {
  policySnapshot: FROZEN_POLICY,
  expiresAt: null,
};
let secretRows: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
const decrypted: string[] = [];
const brokerCalls: Array<{ policy: unknown; secret: string; input: unknown }> = [];
let brokerFailure: Error | null = null;

function sharedSecret(overrides: Record<string, unknown> = {}) {
  return {
    secretId: SECRET_ID,
    ownerUserId: null,
    valueEnc: 'shared-encrypted-value',
    active: true,
    strategy: 'broker',
    egressPolicy: POLICY,
    ...overrides,
  };
}

const databaseMock = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === projectSessions) return { limit: async () => (sessionRow ? [sessionRow] : []) };
        if (table === projectSecrets) return Promise.resolve(secretRows);
        if (table === projectSessionSecretHandles) {
          return {
            orderBy: () => ({ limit: async () => (handleRow ? [handleRow] : []) }),
          };
        }
        throw new Error('unexpected table');
      },
    }),
  }),
};

mock.module('../shared/db', () => ({ db: databaseMock, hasDatabase: true }));
mock.module('../workspaces/lib/access', () => ({
  ...realAccess,
  loadWorkspaceForUser: async () => ({
    row: { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID },
    userId: USER_ID,
  }),
}));
mock.module('../workspaces/secrets', () => ({
  ...realWorkspaceSecrets,
  decryptWorkspaceSecret: (_projectId: string, value: string) => {
    decrypted.push(value);
    return value === 'personal-encrypted-value' ? 'personal-secret-value' : 'shared-secret-value';
  },
}));
mock.module('../shared/audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    audits.push(event);
  },
}));

class MockSecretBrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

mock.module('../secrets/http-broker', () => ({
  SecretBrokerError: MockSecretBrokerError,
  executeSecretBrokerRequest: async (policy: unknown, secret: string, input: unknown) => {
    brokerCalls.push({ policy, secret, input });
    if (brokerFailure) throw brokerFailure;
    return {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body_base64: Buffer.from('{"ok":true}').toString('base64'),
    };
  },
}));

const { workspaceRoutesApp: projectsApp } = await import('../workspaces/lib/app');
await import('../workspaces/routes/secret-broker');

function buildApp() {
  const app = new Hono<{
    Variables: {
      userId: string;
      authType: 'pat' | 'supabase';
      tokenWorkspaceId?: string;
      sessionId?: string;
      agentGrant?: Record<string, unknown> | null;
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', authType);
    if (tokenWorkspaceId) c.set('tokenWorkspaceId', tokenWorkspaceId);
    if (sessionId) c.set('sessionId', sessionId);
    c.set('agentGrant', agentGrant);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function brokerRequest() {
  return buildApp().request(`/v1/projects/${WORKSPACE_ID}/secrets/PRIMARY/broker`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: 'https://api.example.com/v1/messages?trace=private',
      method: 'POST',
      body_base64: Buffer.from('{}').toString('base64'),
    }),
  });
}

describe('POST /v1/projects/:workspaceId/secrets/:identifier/broker', () => {
  beforeEach(() => {
    authType = 'pat';
    tokenWorkspaceId = WORKSPACE_ID;
    sessionId = SESSION_ID;
    agentGrant = {
      agent: 'default',
      kortixCli: 'all',
      connectors: 'all',
      env: ['PRIMARY'],
    };
    sessionRow = { sessionId: SESSION_ID, secretsAllowlist: ['PRIMARY'] };
    handleRow = { policySnapshot: FROZEN_POLICY, expiresAt: null };
    secretRows = [sharedSecret()];
    audits.length = 0;
    decrypted.length = 0;
    brokerCalls.length = 0;
    brokerFailure = null;
  });

  test('requires a session-scoped agent token', async () => {
    authType = 'supabase';
    agentGrant = null;

    const response = await brokerRequest();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'session_agent_token_required' });
    expect(decrypted).toHaveLength(0);
    expect(brokerCalls).toHaveLength(0);
  });

  test('intersects the immutable agent grant with the session allowlist before decryption', async () => {
    agentGrant = {
      agent: 'default',
      kortixCli: 'all',
      connectors: 'all',
      env: ['OTHER'],
    };

    const grantDenied = await brokerRequest();
    expect(grantDenied.status).toBe(403);
    expect(await grantDenied.json()).toMatchObject({ code: 'policy_denied' });
    expect(decrypted).toHaveLength(0);

    agentGrant = {
      agent: 'default',
      kortixCli: 'all',
      connectors: 'all',
      env: ['PRIMARY'],
    };
    sessionRow = { sessionId: SESSION_ID, secretsAllowlist: [] };
    const sessionDenied = await brokerRequest();
    expect(sessionDenied.status).toBe(403);
    expect(await sessionDenied.json()).toMatchObject({ code: 'policy_denied' });
    expect(decrypted).toHaveLength(0);
    expect(audits.every((event) => JSON.stringify(event).includes('shared-secret-value') === false)).toBe(
      true,
    );
  });

  test('accepts a broker handle materialized from an all grant narrowed by the session allowlist', async () => {
    agentGrant = {
      agent: 'default',
      kortixCli: 'all',
      connectors: 'all',
      env: 'all',
    };
    sessionRow = { sessionId: SESSION_ID, secretsAllowlist: ['PRIMARY'] };

    const response = await brokerRequest();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 201 });
    expect(decrypted).toEqual(['shared-encrypted-value']);
    expect(brokerCalls).toHaveLength(1);
  });

  test('uses the shared delivery policy and the active personal value', async () => {
    secretRows = [
      sharedSecret(),
      {
        ...sharedSecret({ secretId: '77777777-7777-4777-8777-777777777777' }),
        ownerUserId: USER_ID,
        valueEnc: 'personal-encrypted-value',
        strategy: 'runtime',
        egressPolicy: null,
      },
    ];

    const response = await brokerRequest();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 201 });
    expect(decrypted).toEqual(['personal-encrypted-value']);
    expect(brokerCalls).toEqual([
      expect.objectContaining({ policy: FROZEN_POLICY, secret: 'personal-secret-value' }),
    ]);
    expect(audits.map((event) => event.action)).toEqual([
      'secret.broker.requested',
      'secret.broker.completed',
    ]);
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain('personal-secret-value');
    expect(serializedAudits).not.toContain('trace=private');
    expect(audits[0]?.metadata).toMatchObject({
      identifier: 'PRIMARY',
      host: 'api.example.com',
      method: 'POST',
      path: '/v1/messages',
    });
  });

  test('rejects runtime delivery without decrypting the value', async () => {
    secretRows = [sharedSecret({ strategy: 'runtime', egressPolicy: null })];

    const response = await brokerRequest();

    expect(response.status).toBe(403);
    expect(decrypted).toHaveLength(0);
    expect(brokerCalls).toHaveLength(0);
  });

  test('requires a materialized active handle before decryption', async () => {
    handleRow = null;

    const response = await brokerRequest();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'session_secret_handle_required' });
    expect(decrypted).toHaveLength(0);
    expect(brokerCalls).toHaveLength(0);
  });

  test('uses the frozen handle policy instead of a changed secret policy', async () => {
    const response = await brokerRequest();

    expect(response.status).toBe(200);
    expect(brokerCalls).toEqual([
      expect.objectContaining({ policy: FROZEN_POLICY, secret: 'shared-secret-value' }),
    ]);
    expect(brokerCalls[0]?.policy).not.toEqual(POLICY);
  });

  test('records broker failures without recording the secret', async () => {
    brokerFailure = new MockSecretBrokerError('upstream_timeout', 'upstream request timed out', 504);

    const response = await brokerRequest();

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: 'upstream_timeout' });
    expect(audits.map((event) => event.action)).toEqual([
      'secret.broker.requested',
      'secret.broker.failed',
    ]);
    expect(JSON.stringify(audits)).not.toContain('shared-secret-value');
  });
});
