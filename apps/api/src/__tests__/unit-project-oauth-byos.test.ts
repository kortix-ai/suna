import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { accountMembers, accountSecretResources } from '@kortix/db';
import * as realAccess from '../projects/lib/access';

// Bring your own ChatGPT subscription (pooled provider secrets): a project
// member without project.secret.write connects and reconnects their OWN
// ChatGPT account. Sharing with anyone else stays a project secret write.

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const MANAGER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_MEMBER_ID = '55555555-5555-4555-8555-555555555555';
const RESOURCE_ID = '77777777-7777-4777-8777-777777777777';

const PROJECT_ACTIONS = {
  PROJECT_CONNECTOR_READ: 'project.connector.read',
  PROJECT_CONNECTOR_WRITE: 'project.connector.write',
  PROJECT_CUSTOMIZE_WRITE: 'project.customize.write',
  PROJECT_SECRET_READ: 'project.secret.read',
  PROJECT_SECRET_WRITE: 'project.secret.write',
};
mock.module('../iam', () => ({ PROJECT_ACTIONS }));

const capabilityChecks: Array<{ userId: string; action: string }> = [];
const auditEvents: Array<Record<string, unknown>> = [];
const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
let deviceStarts = 0;
let pooledEnabled = true;
let resourceRows: Array<Record<string, unknown>> = [];
let updatedRows: Array<Record<string, unknown>> = [];

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === accountMembers) return [{ userId: 'member' }];
            if (table === accountSecretResources) return resourceRows;
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updates.push({ table, values });
            return updatedRows;
          },
        }),
      }),
    }),
  },
}));

mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (c: any) => {
    const userId = c.get('userId') as string;
    return {
      row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, metadata: {} },
      userId,
      accountRole: 'member',
      projectRole: userId === MANAGER_ID ? 'manager' : 'member',
      effectiveRole: userId === MANAGER_ID ? 'manager' : 'member',
      adminBypass: false,
    };
  },
  assertProjectCapability: async (_c: any, userId: string, _accountId: string, _projectId: string, action: string) => {
    capabilityChecks.push({ userId, action });
    if (userId !== MANAGER_ID) throw new HTTPException(403, { message: 'You do not have access to this project' });
  },
}));

mock.module('../feature-flags/registry', () => ({
  resolveFeatureFlag: (_metadata: unknown, key: string) => key === 'pooled_provider_secrets' ? pooledEnabled : false,
}));
mock.module('../llm-gateway/enablement', () => ({ projectLlmGatewayEnabled: () => true }));

mock.module('../projects/codex-device-auth', () => ({
  startCodexDeviceAuth: async () => {
    deviceStarts += 1;
    return { verificationUrl: 'https://auth.example.test/codex/device', userCode: 'TEST-CODE', deviceAuthId: 'device-1', intervalMs: 5000 };
  },
  pollCodexDeviceAuth: async () => ({ status: 'authorized', authJson: '{"openai":{"access":"a","refresh":"r","expires":1}}' }),
}));

// The flow handle is opaque to clients; a readable envelope lets the test
// assert what the server sealed into it.
mock.module('../projects/secrets', () => ({
  encryptProjectSecret: (_projectId: string, value: string) => `sealed:${value}`,
  decryptProjectSecret: (_projectId: string, value: string) => value.replace(/^sealed:/, ''),
  resolveProjectSecretForConsumer: async () => null,
}));
mock.module('../secrets/account-resource', () => ({
  encryptAccountSecret: (_accountId: string, value: string) => `account-sealed:${value}`,
  memberMayReadProject: async () => true,
}));
mock.module('../projects/lib/sandbox-env-sync', () => ({ propagateProjectSecretsToActiveSandboxes: async () => {} }));
mock.module('../shared/audit', () => ({
  inferAuditSource: () => 'api',
  recordAuditEvent: async (event: Record<string, unknown>) => { auditEvents.push(event); },
  runAuditedTransaction: async <T>(operation: () => Promise<T>) => operation(),
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/provider-oauth');

function app(userId: string) {
  const hono = new Hono();
  hono.use('*', async (c: any, next: any) => { c.set('userId', userId); await next(); });
  hono.route('/v1/projects', projectsApp);
  hono.onError((err, c) => err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500));
  return hono;
}

async function start(userId: string, body: Record<string, unknown>) {
  const res = await app(userId).request(`/v1/projects/${PROJECT_ID}/oauth/openai/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function poll(userId: string, flowId: string) {
  const res = await app(userId).request(`/v1/projects/${PROJECT_ID}/oauth/openai/poll`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow_id: flowId }),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const sealedState = (flowId: string) => JSON.parse(flowId.replace(/^sealed:/, '')) as Record<string, unknown>;

const codexResource = (overrides: Record<string, unknown> = {}) => ({
  secretId: RESOURCE_ID, projectId: PROJECT_ID, providerId: 'codex', name: 'CODEX_AUTH_JSON',
  createdBy: MEMBER_ID, label: 'ChatGPT · Member', ...overrides,
});

beforeEach(() => {
  capabilityChecks.length = 0;
  auditEvents.length = 0;
  updates.length = 0;
  deviceStarts = 0;
  pooledEnabled = true;
  resourceRows = [];
  updatedRows = [];
});

describe('POST /oauth/openai/start — a member connects their own ChatGPT account', () => {
  test.each([
    ['only the member, as a selected member', { mode: 'members', memberIds: [MEMBER_ID] }],
    ['private', { mode: 'private' }],
    ['an empty member list', { mode: 'members', memberIds: [] }],
  ])('%s needs no project secret write', async (_name, sharing) => {
    const result = await start(MEMBER_ID, { resource_label: 'ChatGPT · Member', sharing });
    expect(result.status).toBe(200);
    expect(result.body.user_code).toBe('TEST-CODE');
    expect(capabilityChecks).toEqual([]);
    expect(deviceStarts).toBe(1);
  });

  test.each([
    ['the whole project', { mode: 'project' }],
    ['another member', { mode: 'members', memberIds: [MEMBER_ID, OTHER_MEMBER_ID] }],
  ])('sharing with %s requires project secret write before any device code', async (_name, sharing) => {
    const result = await start(MEMBER_ID, { resource_label: 'Team ChatGPT', sharing });
    expect(result.status).toBe(403);
    expect(capabilityChecks).toEqual([{ userId: MEMBER_ID, action: PROJECT_ACTIONS.PROJECT_SECRET_WRITE }]);
    expect(deviceStarts).toBe(0);
  });

  test('a manager may share an account with the project', async () => {
    const result = await start(MANAGER_ID, { resource_label: 'Team ChatGPT', sharing: { mode: 'project' } });
    expect(result.status).toBe(200);
    expect(capabilityChecks).toEqual([{ userId: MANAGER_ID, action: PROJECT_ACTIONS.PROJECT_SECRET_WRITE }]);
  });
});

describe('POST /oauth/openai/start — reconnect an existing ChatGPT account in place', () => {
  test('the account owner reconnects without a secret write; the handle targets the same resource', async () => {
    resourceRows = [codexResource()];
    const result = await start(MEMBER_ID, { resource_id: RESOURCE_ID });
    expect(result.status).toBe(200);
    expect(capabilityChecks).toEqual([]);
    const state = sealedState(result.body.flow_id);
    expect(state).toMatchObject({ rid: RESOURCE_ID, rc: 1, uid: MEMBER_ID });
    expect(state).not.toHaveProperty('l');
  });

  test('another member cannot reconnect the account', async () => {
    resourceRows = [codexResource({ createdBy: OTHER_MEMBER_ID })];
    const result = await start(MEMBER_ID, { resource_id: RESOURCE_ID });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('Only the person who connected this ChatGPT account can reconnect it');
    expect(deviceStarts).toBe(0);
  });

  test.each([
    ['is missing', []],
    ['belongs to another project', [codexResource({ projectId: OTHER_PROJECT_ID })]],
    ['is not a ChatGPT account', [codexResource({ providerId: 'anthropic', name: 'ANTHROPIC_API_KEY' })]],
  ])('an account that %s is not found', async (_name, rows) => {
    resourceRows = rows;
    const result = await start(MEMBER_ID, { resource_id: RESOURCE_ID });
    expect(result.status).toBe(404);
    expect(deviceStarts).toBe(0);
  });

  test.each([
    ['a label', { resource_label: 'Renamed' }],
    ['sharing', { sharing: { mode: 'project' } }],
  ])('reconnect rejects %s: it never changes identity or access', async (_name, extra) => {
    resourceRows = [codexResource()];
    const result = await start(MEMBER_ID, { resource_id: RESOURCE_ID, ...extra });
    expect(result.status).toBe(400);
    expect(deviceStarts).toBe(0);
  });

  test('a malformed resource id is rejected', async () => {
    const result = await start(MEMBER_ID, { resource_id: 'not-a-uuid' });
    expect(result.status).toBe(400);
  });

  test('reconnect requires pooled provider secrets', async () => {
    pooledEnabled = false;
    resourceRows = [codexResource()];
    const result = await start(MEMBER_ID, { resource_id: RESOURCE_ID });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('Pooled OAuth connections require pooled provider secrets and the LLM gateway');
    expect(deviceStarts).toBe(0);
  });
});

describe('POST /oauth/openai/poll — reconnect writes the new login into the same account', () => {
  const reconnectHandle = (userId = MEMBER_ID) => `sealed:${JSON.stringify({
    d: 'device-1', u: 'TEST-CODE', s: null, uid: userId, rid: RESOURCE_ID, rc: 1, e: Date.now() + 60_000,
  })}`;

  test('success replaces the value, re-activates it, clears the cooldown and keeps the id', async () => {
    updatedRows = [{ secretId: RESOURCE_ID, label: 'ChatGPT · Member' }];
    const result = await poll(MEMBER_ID, reconnectHandle());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      credential: { provider_id: 'codex', secret_id: RESOURCE_ID, label: 'ChatGPT · Member' },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe(accountSecretResources);
    expect(updates[0]!.values).toMatchObject({
      valueEnc: 'account-sealed:{"openai":{"access":"a","refresh":"r","expires":1}}',
      active: true,
      cooldownUntil: null,
    });
    expect(auditEvents).toContainEqual(expect.objectContaining({
      action: 'secret.oauth.connected', resourceType: 'account_secret_resource', resourceId: RESOURCE_ID,
      metadata: expect.objectContaining({ provider_id: 'codex', reconnected: true }),
    }));
  });

  test('an account deleted during authorization fails without creating a new one', async () => {
    updatedRows = [];
    const result = await poll(MEMBER_ID, reconnectHandle());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'failed', error: 'This ChatGPT account is no longer available. Add it again.' });
    expect(auditEvents).toEqual([]);
  });
});
