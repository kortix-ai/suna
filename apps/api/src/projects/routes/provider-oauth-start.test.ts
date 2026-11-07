/**
 * POST /v1/projects/:projectId/oauth/:provider/start — request validation.
 *
 * Characterization pin (KRTX-4440): every refusal body and status of the start
 * callback, in the order the callback produces them, plus the accepted shapes
 * that reach the provider's device-flow start. `mock.module` is process-global
 * in bun:test, so this runs in its own file.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '00000000-0000-4000-a000-00000044a001';
const ACCOUNT_ID = '00000000-0000-4000-a000-00000044a002';
const USER_ID = '00000000-0000-4000-a000-00000044a003';
const OTHER_USER_ID = '00000000-0000-4000-a000-00000044a004';
const RESOURCE_ID = '00000000-0000-4000-a000-00000044a005';

let projectMetadata: unknown = null;
let projectFound = true;
let memberFound = true;
/** The account resource row `db.select` resolves; `undefined` = none. */
let resourceRow: Record<string, unknown> | undefined;
let memberMayRead = true;
let capabilityCalls: string[] = [];
let startCalls = 0;
let startError: Error | null = null;

mock.module('../../shared/db', () => ({
  withDbTransaction: <T,>(action: () => Promise<T>): Promise<T> => action(),
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (resourceRow ? [resourceRow] : []) }),
      }),
    }),
  },
}));

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () =>
    projectFound
      ? {
          userId: USER_ID,
          row: { projectId: PROJECT_ID, accountId: ACCOUNT_ID, metadata: projectMetadata },
          projectRole: 'manager',
          effectiveRole: 'manager',
        }
      : null,
  assertProjectCapability: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => {
    capabilityCalls.push(action);
  },
}));

const realMembership = await import('../../iam/membership-read');
mock.module('../../iam/membership-read', () => ({
  ...realMembership,
  accountMemberRow: async () => (memberFound ? [{ userId: USER_ID }] : []),
}));

const realAccountResource = await import('../../secrets/account-resource');
mock.module('../../secrets/account-resource', () => ({
  ...realAccountResource,
  memberMayReadProject: async () => memberMayRead,
}));

const realCodex = await import('../codex-device-auth');
mock.module('../codex-device-auth', () => ({
  ...realCodex,
  startCodexDeviceAuth: async () => {
    startCalls += 1;
    if (startError) throw startError;
    return { verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234', deviceAuthId: 'dev-1', intervalMs: 1000 };
  },
}));

const { projectsApp } = await import('../lib/app');
(await import('./provider-oauth')).registerProviderOauthRoutes();

function start(body: unknown, provider = 'openai') {
  return projectsApp.request(`/${PROJECT_ID}/oauth/${provider}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function refusal(body: unknown, provider = 'openai') {
  const response = await start(body, provider);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  projectMetadata = null;
  projectFound = true;
  memberFound = true;
  resourceRow = undefined;
  memberMayRead = true;
  capabilityCalls = [];
  startCalls = 0;
  startError = null;
});

describe('POST /:projectId/oauth/:provider/start — refusals', () => {
  test('an unknown project is 404 before the provider is looked at', async () => {
    projectFound = false;
    expect(await refusal({}, 'nope')).toEqual({ status: 404, body: { error: 'Not found' } });
  });

  test('an unsupported provider is 400', async () => {
    expect(await refusal({}, 'nope')).toEqual({
      status: 400,
      body: { error: 'OAuth device flow is not available for "nope"' },
    });
  });

  test.each([
    ['empty', ''],
    ['blank after trim', '   '],
    ['101 characters', 'x'.repeat(101)],
    ['not a string', 7],
  ])('a resource_label that is %s is 400', async (_name, resource_label) => {
    expect(await refusal({ resource_label })).toEqual({
      status: 400,
      body: { error: 'A named OAuth resource requires a 1–100 character label' },
    });
  });

  test.each([
    ['not a uuid', 'abc'],
    ['empty', ''],
    ['not a string', 7],
  ])('a resource_id that is %s is 400', async (_name, resource_id) => {
    expect(await refusal({ resource_id })).toEqual({
      status: 400,
      body: { error: 'resource_id must be the id of a ChatGPT account' },
    });
  });

  test('the label check runs before the resource_id check', async () => {
    expect((await refusal({ resource_label: '', resource_id: 'abc' })).body).toEqual({
      error: 'A named OAuth resource requires a 1–100 character label',
    });
  });

  test('a resource_id with a label is 400', async () => {
    expect(await refusal({ resource_id: RESOURCE_ID, resource_label: 'Work' })).toEqual({
      status: 400,
      body: { error: 'Reconnecting keeps the account label and access; send only resource_id' },
    });
  });

  test('a resource_id with sharing is 400', async () => {
    expect(await refusal({ resource_id: RESOURCE_ID, sharing: { mode: 'project' } })).toEqual({
      status: 400,
      body: { error: 'Reconnecting keeps the account label and access; send only resource_id' },
    });
  });

  test('a named connection while pooled provider secrets are off is 403', async () => {
    projectMetadata = { experimental: { pooled_provider_secrets: false } };
    expect(await refusal({ resource_label: 'Work' })).toEqual({
      status: 403,
      body: { error: 'Pooled OAuth connections require pooled provider secrets' },
    });
  });

  test('a named connection by a non-member is 403', async () => {
    memberFound = false;
    expect(await refusal({ resource_label: 'Work' })).toEqual({
      status: 403,
      body: { error: 'An account member must own a ChatGPT connection' },
    });
    expect(startCalls).toBe(0);
  });

  test('a reconnect of a missing account is 404', async () => {
    expect(await refusal({ resource_id: RESOURCE_ID })).toEqual({
      status: 404,
      body: { error: 'ChatGPT account not found' },
    });
  });

  test.each([
    ['another project', { projectId: 'other' }],
    ['another provider', { providerId: 'other' }],
    ['another secret name', { name: 'OTHER' }],
  ])('a reconnect of an account in %s is 404', async (_name, patch) => {
    resourceRow = { projectId: PROJECT_ID, providerId: 'codex', name: 'CODEX_AUTH_JSON', createdBy: USER_ID, ...patch };
    expect(await refusal({ resource_id: RESOURCE_ID })).toEqual({
      status: 404,
      body: { error: 'ChatGPT account not found' },
    });
  });

  test("a reconnect of someone else's account is 403", async () => {
    resourceRow = { projectId: PROJECT_ID, providerId: 'codex', name: 'CODEX_AUTH_JSON', createdBy: OTHER_USER_ID };
    expect(await refusal({ resource_id: RESOURCE_ID })).toEqual({
      status: 403,
      body: { error: 'Only the person who connected this ChatGPT account can reconnect it' },
    });
  });

  test('a sharing body with an unknown mode is 400', async () => {
    expect(await refusal({ sharing: { mode: 'everyone' } })).toEqual({
      status: 400,
      body: { error: 'invalid sharing — mode must be project|private|members' },
    });
  });

  test('a named private connection owned by someone else is 400', async () => {
    expect(await refusal({ resource_label: 'Work', sharing: { mode: 'private', ownerId: OTHER_USER_ID } })).toEqual({
      status: 400,
      body: { error: 'Invalid connection owner' },
    });
  });

  test('a named members connection with a group is 400', async () => {
    expect(await refusal({ resource_label: 'Work', sharing: { mode: 'members', groupIds: ['g1'] } })).toEqual({
      status: 400,
      body: { error: 'Select up to 200 workspace members' },
    });
  });

  test('a named members connection with more than 200 members is 400', async () => {
    const memberIds = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-a000-${String(i).padStart(12, '0')}`);
    expect(await refusal({ resource_label: 'Work', sharing: { mode: 'members', memberIds } })).toEqual({
      status: 400,
      body: { error: 'Select up to 200 workspace members' },
    });
  });

  test.each([
    ['a member id that is not a uuid', ['not-a-uuid'], true],
    ['a member without project access', [OTHER_USER_ID], false],
  ])('a named members connection with %s is 400', async (_name, memberIds, mayRead) => {
    memberMayRead = mayRead;
    expect(await refusal({ resource_label: 'Work', sharing: { mode: 'members', memberIds } })).toEqual({
      status: 400,
      body: { error: 'Member has no project access' },
    });
  });

  test('an unnamed connection skips the owner and member checks of sharing', async () => {
    const response = await start({ sharing: { mode: 'private', ownerId: OTHER_USER_ID } });
    expect(response.status).toBe(200);
  });

  test('a provider failure is 502 with its message', async () => {
    startError = new Error('upstream down');
    expect(await refusal({})).toEqual({ status: 502, body: { error: 'upstream down' } });
  });
});

describe('POST /:projectId/oauth/:provider/start — accepted requests', () => {
  test('an unnamed request needs the project secret write capability', async () => {
    const response = await start({});
    expect(response.status).toBe(200);
    expect(capabilityCalls).toEqual(['project.secret.write']);
    expect(startCalls).toBe(1);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.user_code).toBe('ABCD-1234');
    expect(body.verification_url).toBe('https://auth.example/device');
    expect(body.interval_ms).toBe(3000);
    expect(typeof body.flow_id).toBe('string');
  });

  test('a private request needs no capability beyond read', async () => {
    expect((await start({ sharing: { mode: 'private' } })).status).toBe(200);
    expect(capabilityCalls).toEqual([]);
  });

  test.each([
    ['a named private connection', { resource_label: ' Work ', sharing: { mode: 'private' } }],
    ['a named members connection of only the caller', { resource_label: 'Work', sharing: { mode: 'members', memberIds: [USER_ID] } }],
  ])('%s is owner-only: no capability check', async (_name, body) => {
    expect((await start(body)).status).toBe(200);
    expect(capabilityCalls).toEqual([]);
  });

  test('a named connection with no sharing is shared, so it needs the secret write capability', async () => {
    expect((await start({ resource_label: 'Work' })).status).toBe(200);
    expect(capabilityCalls).toEqual(['project.secret.write']);
  });

  test('a named project-wide connection needs the secret write capability', async () => {
    expect((await start({ resource_label: 'Work', sharing: { mode: 'project' } })).status).toBe(200);
    expect(capabilityCalls).toEqual(['project.secret.write']);
  });

  test('a named members connection of accessible members is accepted and shared', async () => {
    const response = await start({ resource_label: 'Work', sharing: { mode: 'members', memberIds: [OTHER_USER_ID] } });
    expect(response.status).toBe(200);
    expect(capabilityCalls).toEqual(['project.secret.write']);
  });

  test("a reconnect of the caller's own account is owner-only", async () => {
    resourceRow = { projectId: PROJECT_ID, providerId: 'codex', name: 'CODEX_AUTH_JSON', createdBy: USER_ID };
    expect((await start({ resource_id: RESOURCE_ID })).status).toBe(200);
    expect(capabilityCalls).toEqual([]);
  });
});
