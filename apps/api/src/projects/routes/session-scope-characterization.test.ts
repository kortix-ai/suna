/**
 * Characterization for PUT /v1/projects/:projectId/sessions/:sessionId/scope.
 *
 * Pins the wire envelope the re-scope handler answers with — dropped/added
 * secrets, `retroactive`, `applied_live`, `push_failed`, the `detail` strings,
 * the shaped 403/409/400 bodies, and the write order — BEFORE the handler is
 * split into decision helpers, so the split can be judged behavior-preserving.
 * Every test runs through the real Hono app with the DB and the sandbox push
 * mocked at module level; no live database is involved.
 *
 * Pins that would need a live DB (the route's real reads: project row, session
 * row, resolved secrets, effective bindings) are faked here by design — the
 * decision logic under test is the pure part of the handler.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// The REAL modules, imported before mock.module replaces them: the tests keep
// the pure decision code (rescopeSessionSecrets/rescopeSessionBindings,
// secretKeyCollisionInAllowlist, sessionConnectorBindingsRequirePrivateVisibility)
// real and fake only the DB-backed collaborators.
import * as realAccess from '../lib/access';
import * as realScb from '../lib/session-connector-bindings';
import * as realSecrets from '../secrets';
import { projectSessionConnectorBindings, serviceAccounts } from '@kortix/db';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CONN_ID = '99999999-9999-4999-8999-999999999999';
const CONN_ID_2 = '88888888-8888-4888-8888-888888888888';

let loadedProject: any = null;
let visibleSession: any = null;
let durableBindingRows: Array<{ alias: string; connectionId: string }> = [];
let serviceAccountRows: Array<{ serviceAccountId: string }> = [];
let effectiveMaps: Array<Record<string, { connection_id: string }>> = [];
let effectiveCalls = 0;
let availableSecrets: Array<{ secretId: string; identifier: string; key: string; value: string }> = [];
let canReadSecretNames = true;
let grantValue: any = null;
let grantThrows: string | null = null;
let personalOwner: string | null = OWNER_ID;
let pushResult: { applied: boolean; reason?: string } = { applied: true };
let pushCalls = 0;
const writeCalls: string[] = [];
let updateSets: Array<Record<string, unknown>> = [];
let insertValues: Array<unknown> = [];

const baseLoadedRow = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  repoUrl: null,
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  metadata: {},
};
const baseVisibleRow = {
  sessionId: SESSION_ID,
  agentName: 'default',
  createdBy: OWNER_ID,
  visibility: 'private',
  status: 'running',
  metadata: {},
  secretsAllowlist: null as string[] | null,
  connectorBindingsConfigured: false,
  connectorBindingsInheritUnbound: false,
};

const okValidated = (bindings: Record<string, { connection_id: string }>) => ({
  ok: true as const,
  bindings: Object.entries(bindings).map(([alias, binding]) => ({
    alias,
    connectionId: binding.connection_id,
    connectorId: '11111111-1111-4111-8111-111111111111',
    ownerType: 'account',
    ownerId: null,
    personal: false,
  })),
});

mock.module('../../shared/db', () => ({
  db: {
    select: (_proj: unknown) => ({
      from: (table: unknown) => {
        const rows =
          table === projectSessionConnectorBindings
            ? durableBindingRows
            : table === serviceAccounts
              ? serviceAccountRows
              : [];
        return {
          where: (_w: unknown) => ({
            limit: async (n: number) => rows.slice(0, n),
            // The durable-bindings read awaits the chain directly (no .limit).
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(rows).then(res, rej),
          }),
        };
      },
    }),
    transaction: async (fn: (tx: any) => Promise<unknown>) => {
      writeCalls.push('transaction');
      const tx = {
        update: (_t: unknown) => ({
          set: (s: Record<string, unknown>) => ({
            where: async () => {
              writeCalls.push('update');
              updateSets.push(s);
            },
          }),
        }),
        delete: (_t: unknown) => ({
          where: async () => {
            writeCalls.push('delete');
          },
        }),
        insert: (_t: unknown) => ({
          values: (v: unknown) => {
            insertValues.push(v);
            // `await tx.insert(t).values(rows)` awaits the values() result
            // directly — it must be thenable to record the write.
            const then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
              writeCalls.push('insert');
              return Promise.resolve().then(res, rej);
            };
            return { then, where: then };
          },
        }),
      };
      return fn(tx);
    },
  },
  hasDatabase: true,
}));

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => loadedProject,
  assertProjectCapability: async () => {},
  loadVisibleSession: async () => visibleSession,
  projectCapabilityAllowed: async () => canReadSecretNames,
}));

mock.module('../lib/session-connector-bindings', () => ({
  ...realScb,
  resolveEffectiveSessionConnectorBindings: async () => {
    const map = effectiveMaps[Math.min(effectiveCalls, effectiveMaps.length - 1)];
    effectiveCalls += 1;
    return map;
  },
  invalidateSessionConnectorLookup: () => {},
  validateSessionConnectorBindings: async (input: { bindings: Record<string, { connection_id: string }> }) =>
    okValidated(input.bindings ?? {}),
}));

mock.module('../secrets', () => ({
  ...realSecrets,
  listResolvedProjectSecrets: async () => availableSecrets,
}));

mock.module('../lib/personal-resources', () => ({
  resolveSessionPersonalOwner: async () => personalOwner,
}));

mock.module('../lib/secret-grant', () => ({
  resolveSessionAgentGrant: async () => {
    if (grantThrows) throw new Error(grantThrows);
    return grantValue;
  },
}));

mock.module('../lib/sandbox-env-sync', () => ({
  pushSessionScopeToSandbox: async () => {
    pushCalls += 1;
    return pushResult;
  },
  pushSessionModelToSandbox: async () => ({ applied: true }),
}));

mock.module('../../iam/agent-scope', () => ({
  assertAgentScope: () => {},
}));

const { projectsApp } = await import('../lib/app');
const scopeModule = await import('./session-scope');
const { decideSecretsRescope, decideBindingsRescope, scopeResponseDetail } = scopeModule;

function buildApp() {
  const app = new Hono<{ Variables: { userId: string; authType: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function putScope(body: unknown) {
  return buildApp().request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/scope`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  loadedProject = { row: { ...baseLoadedRow }, userId: USER_ID };
  visibleSession = { row: { ...baseVisibleRow }, canManageLifecycle: true };
  durableBindingRows = [];
  serviceAccountRows = [];
  effectiveMaps = [{}];
  effectiveCalls = 0;
  availableSecrets = [];
  canReadSecretNames = true;
  grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: 'all' };
  grantThrows = null;
  personalOwner = OWNER_ID;
  pushResult = { applied: true };
  pushCalls = 0;
  writeCalls.length = 0;
  updateSets = [];
  insertValues = [];
});

const liveNarrowedDetail =
  'Dropped secrets are cleared from the running sandbox now; new shells and the OpenCode process no longer see them. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.';
const nextPromptNarrowedDetail =
  'Dropped secrets stop being delivered from the next prompt. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.';
const liveAppliedDetail =
  'Applied to the running sandbox now — the OpenCode process and new shells see the new scope.';
const nextPromptAppliedDetail = 'Applies from the next prompt.';
const clearsDetail = 'Connector access is back to the project defaults.';
const noChangeDetail = 'No change to the secrets scope.';

describe('PUT scope — secrets-only narrowing envelope', () => {
  test('a narrowing on a live sandbox reports the dropped name, retroactive=false, applied_live=true', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA', 'BETA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA', 'BETA'] };
    availableSecrets = [
      { secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' },
      { secretId: 's2', identifier: 'BETA', key: 'BETA', value: 'v2' },
    ];

    const res = await putScope({ secrets: ['ALPHA'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      secrets_allowlist: ['ALPHA'],
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: ['BETA'],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: false,
      connector_bindings_configured: false,
      connector_bindings_inherit_unbound: false,
      applied_live: true,
      detail: liveNarrowedDetail,
    });
    // Secrets-only: one UPDATE, no binding writes, exactly one push.
    expect(writeCalls).toEqual(['transaction', 'update']);
    expect(updateSets[0]).toMatchObject({ secretsAllowlist: ['ALPHA'] });
    expect(pushCalls).toBe(1);
  });

  test('the same narrowing with no live push says it applies from the next prompt and flags push_failed', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA', 'BETA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA', 'BETA'] };
    availableSecrets = [
      { secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' },
      { secretId: 's2', identifier: 'BETA', key: 'BETA', value: 'v2' },
    ];
    pushResult = { applied: false, reason: 'no active sandbox' };

    const res = await putScope({ secrets: ['ALPHA'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.applied_live).toBe(false);
    expect(body.push_failed).toBe(true);
    expect(body.push_reason).toBe('no active sandbox');
    expect(body.detail).toBe(nextPromptNarrowedDetail);
    expect(body.retroactive).toBe(false);
  });

  test('the dropped NAMES are gated on secret read, but the warning is not', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA', 'BETA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA', 'BETA'] };
    availableSecrets = [
      { secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' },
      { secretId: 's2', identifier: 'BETA', key: 'BETA', value: 'v2' },
    ];
    canReadSecretNames = false;

    const res = await putScope({ secrets: ['ALPHA'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dropped_secrets).toEqual([]);
    expect(body.retroactive).toBe(false);
    expect(body.detail).toBe(liveNarrowedDetail);
  });

  test('a widening is added_secrets with retroactive=true', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA', 'BETA'] };
    availableSecrets = [
      { secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' },
      { secretId: 's2', identifier: 'BETA', key: 'BETA', value: 'v2' },
    ];

    const res = await putScope({ secrets: ['ALPHA', 'BETA'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.secrets_allowlist).toEqual(['ALPHA', 'BETA']);
    expect(body.dropped_secrets).toEqual([]);
    expect(body.added_secrets).toEqual(['BETA']);
    expect(body.retroactive).toBe(true);
    expect(body.applied_live).toBe(true);
    expect(body.detail).toBe(liveAppliedDetail);
  });

  test('a widening with no live push says it applies from the next prompt', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA', 'BETA'] };
    availableSecrets = [
      { secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' },
      { secretId: 's2', identifier: 'BETA', key: 'BETA', value: 'v2' },
    ];
    pushResult = { applied: false, reason: 'no active sandbox' };

    const res = await putScope({ secrets: ['ALPHA', 'BETA'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.added_secrets).toEqual(['BETA']);
    expect(body.applied_live).toBe(false);
    expect(body.detail).toBe(nextPromptAppliedDetail);
  });

  test('a no-op re-scope writes and pushes nothing', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA'] };
    availableSecrets = [{ secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' }];

    const res = await putScope({ secrets: ['ALPHA'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.secrets_allowlist).toEqual(['ALPHA']);
    expect(body.dropped_secrets).toEqual([]);
    expect(body.added_secrets).toEqual([]);
    expect(body.retroactive).toBe(true);
    expect(body.applied_live).toBe(false);
    expect(body.push_failed).toBeUndefined();
    expect(body.detail).toBe(noChangeDetail);
    expect(pushCalls).toBe(0);
  });
});

describe('PUT scope — secrets decision refusals', () => {
  test('a name outside the agent grant is a 403 NOT_IN_AGENT_GRANT with no writes', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA'] };

    const res = await putScope({ secrets: ['ALPHA', 'ZED'] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "not in this agent's secrets grant: ZED — a session may narrow within the grant, never past it",
      code: 'NOT_IN_AGENT_GRANT',
    });
    expect(writeCalls).toEqual([]);
    expect(pushCalls).toBe(0);
  });

  test('an identifier the session owner cannot resolve is a 403 SECRET_IDENTIFIER_NOT_AVAILABLE', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: 'all' };
    availableSecrets = [{ secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' }];

    const res = await putScope({ secrets: ['ALPHA', 'GHOST'] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'secret identifier is not available: GHOST',
      code: 'SECRET_IDENTIFIER_NOT_AVAILABLE',
    });
    // Availability is resolved for the session OWNER (createdBy), not the caller.
    expect(personalOwner).toBe(OWNER_ID);
  });

  test('two identifiers on one env key are a 409 SECRET_IDENTIFIER_KEY_COLLISION', async () => {
    visibleSession!.row.secretsAllowlist = null;
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: 'all' };
    availableSecrets = [
      { secretId: 's1', identifier: 'MAPS_PRIMARY', key: 'GOOGLE_MAPS_API_KEY', value: 'v1' },
      { secretId: 's2', identifier: 'MAPS_BACKUP', key: 'GOOGLE_MAPS_API_KEY', value: 'v2' },
    ];

    const res = await putScope({ secrets: ['MAPS_PRIMARY', 'MAPS_BACKUP'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'secrets allowlist names multiple identifiers for env key "GOOGLE_MAPS_API_KEY": MAPS_BACKUP, MAPS_PRIMARY',
      code: 'SECRET_IDENTIFIER_KEY_COLLISION',
    });
  });
});

describe('PUT scope — bindings envelope', () => {
  test('connector_bindings: null clears the override, drops the effective aliases, and reverts to inheriting', async () => {
    durableBindingRows = [{ alias: 'gmail', connectionId: 'p1' }];
    effectiveMaps = [{ gmail: { connection_id: 'p1' } }, {}];

    const res = await putScope({ connector_bindings: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      secrets_allowlist: null,
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: ['gmail'],
      retroactive: true,
      connector_bindings_configured: false,
      connector_bindings_inherit_unbound: false,
      applied_live: false,
      detail: clearsDetail,
    });
    // Write order: UPDATE the row, DELETE the stored bindings; no INSERT (zero rows).
    expect(writeCalls).toEqual(['transaction', 'update', 'delete']);
    expect(updateSets[0]).toMatchObject({ connectorBindingsConfigured: false });
    expect(pushCalls).toBe(0);
  });

  test('an explicit bindings map replaces the stored rows, writes update+delete+insert in order', async () => {
    durableBindingRows = [{ alias: 'gmail', connectionId: CONN_ID }];
    effectiveMaps = [{ gmail: { connection_id: CONN_ID } }, { gmail: { connection_id: CONN_ID_2 } }];

    const res = await putScope({ connector_bindings: { gmail: { connection_id: CONN_ID_2 } } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connector_bindings).toEqual({ gmail: { connection_id: CONN_ID_2 } });
    expect(body.dropped_bindings).toEqual([]);
    expect(body.connector_bindings_configured).toBe(true);
    expect(body.retroactive).toBe(true);
    expect(body.applied_live).toBe(false);
    expect(body.detail).toBe(noChangeDetail);
    expect(writeCalls).toEqual(['transaction', 'update', 'delete', 'insert']);
    expect(insertValues).toHaveLength(1);
    expect((insertValues[0] as Array<Record<string, unknown>>)[0]).toMatchObject({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      connectionId: CONN_ID_2,
      source: 'request',
      createdBy: USER_ID,
    });
  });

  test('an alias the agent is not granted is a 403 NOT_GRANTED_CONNECTOR with no writes', async () => {
    grantValue = { agent: 'default', permissions: 'all', connectors: ['gmail'], env: 'all' };

    const res = await putScope({ connector_bindings: { zendesk: { connection_id: CONN_ID } } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        'not granted to this agent: zendesk — binding an alias the manifest does not grant would 403 at the first tool call',
      code: 'NOT_GRANTED_CONNECTOR',
    });
    expect(writeCalls).toEqual([]);
  });
});

describe('PUT scope — prologue refusals', () => {
  test('an unresolved agent grant is a 409 AGENT_GRANT_UNRESOLVED, fail-closed', async () => {
    grantThrows = 'manifest unavailable';

    const res = await putScope({ secrets: ['ALPHA'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "could not resolve this agent's grant, so the new scope cannot be checked against it: manifest unavailable",
      code: 'AGENT_GRANT_UNRESOLVED',
    });
  });

  test('a viewer who cannot manage the session lifecycle is a 403 owner-or-manager refusal', async () => {
    visibleSession!.canManageLifecycle = false;

    const res = await putScope({ secrets: ['ALPHA'] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Only the session owner or a project manager can re-scope this session',
    });
  });

  test('a deprecated require_connectors-only body is accepted as a no-op re-scope', async () => {
    // `require_connectors` is inert but accepted; naming it (and only it)
    // satisfies the schema refine, so the handler runs and answers the
    // no-change envelope.
    const res = await putScope({ require_connectors: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toBe(noChangeDetail);
    expect(body.retroactive).toBe(true);
    expect(body.applied_live).toBe(false);
    expect(pushCalls).toBe(0);
  });

  test('a malformed secrets entry is rejected by the wire validator before the handler', async () => {
    // The route declares `SessionScopeInputSchema` on the request, so
    // hono-zod-openapi rejects a malformed body with its own 400 before the
    // handler runs. The handler's own `INVALID_SESSION_SCOPE` safeParse branch
    // is defense in depth: with the same schema it is not wire-reachable.
    const res = await putScope({ secrets: ['bad identifier!'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe(true);
    expect(body.message).toBe('Validation failed');
    expect((body.issues as Array<{ path: unknown }>)[0].path).toEqual(['secrets', 0]);
  });
});

/**
 * The extracted decision helpers, called directly over the same mocked DB.
 *
 * The route-level pins above are the pre/post-refactor characterization (they
 * ran green against the inline handler before the split). These exercise the
 * helpers' own contracts — success fields vs the shaped 403/409 Response —
 * so a future change to a helper fails here, at the helper, not three layers
 * out.
 */
describe('the extracted decision helpers', () => {
  // Minimal stand-in for the Hono context: the helpers only ever call c.json.
  const fakeC = {
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), { status: status ?? 200 }),
  } as any;

  test('decideSecretsRescope returns the five fields for an in-grant narrowing', async () => {
    visibleSession!.row.secretsAllowlist = ['ALPHA', 'BETA'];
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA', 'BETA'] };
    availableSecrets = [
      { secretId: 's1', identifier: 'ALPHA', key: 'ALPHA', value: 'v1' },
      { secretId: 's2', identifier: 'BETA', key: 'BETA', value: 'v2' },
    ];

    const decided = await decideSecretsRescope({
      c: fakeC,
      loaded: loadedProject,
      visible: visibleSession,
      projectId: PROJECT_ID,
      grant: grantValue,
      body: { secrets: ['ALPHA'] },
      wantsSecrets: true,
    });
    expect(decided).toEqual({
      nextAllowlist: ['ALPHA'],
      droppedSecrets: ['BETA'],
      addedSecrets: [],
      narrowedSecrets: true,
      canReadSecretNames: true,
    });
  });

  test('decideSecretsRescope returns the shaped 403 outside the grant', async () => {
    grantValue = { agent: 'default', permissions: 'all', connectors: 'all', env: ['ALPHA'] };

    const decided = await decideSecretsRescope({
      c: fakeC,
      loaded: loadedProject,
      visible: visibleSession,
      projectId: PROJECT_ID,
      grant: grantValue,
      body: { secrets: ['ALPHA', 'ZED'] },
      wantsSecrets: true,
    });
    expect(decided).toBeInstanceOf(Response);
    const res = decided as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "not in this agent's secrets grant: ZED — a session may narrow within the grant, never past it",
      code: 'NOT_IN_AGENT_GRANT',
    });
  });

  test('decideBindingsRescope returns the rows for a valid set', async () => {
    const decided = await decideBindingsRescope({
      c: fakeC,
      loaded: loadedProject,
      visible: visibleSession,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      grant: { agent: 'default', permissions: 'all', connectors: 'all' },
      body: { connector_bindings: { gmail: { connection_id: CONN_ID } } },
      wantsBindings: true,
      clearsBindings: false,
      currentDurableBindings: {},
      currentEffectiveBindingIds: {},
    });
    expect(decided).toEqual({
      bindingRows: [
        {
          sessionId: SESSION_ID,
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          connectorAlias: 'gmail',
          connectorId: '11111111-1111-4111-8111-111111111111',
          connectionId: CONN_ID,
          source: 'request',
          createdBy: USER_ID,
        },
      ],
    });
  });

  test('decideBindingsRescope returns the shaped 403 for an ungranted alias', async () => {
    const decided = await decideBindingsRescope({
      c: fakeC,
      loaded: loadedProject,
      visible: visibleSession,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      grant: { agent: 'default', permissions: 'all', connectors: ['gmail'] },
      body: { connector_bindings: { zendesk: { connection_id: CONN_ID } } },
      wantsBindings: true,
      clearsBindings: false,
      currentDurableBindings: {},
      currentEffectiveBindingIds: {},
    });
    expect(decided).toBeInstanceOf(Response);
    const res = decided as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        'not granted to this agent: zendesk — binding an alias the manifest does not grant would 403 at the first tool call',
      code: 'NOT_GRANTED_CONNECTOR',
    });
  });

  test('scopeResponseDetail covers all six outcomes', () => {
    expect(
      scopeResponseDetail({ scopeSecretsChanged: true, narrowedSecrets: true, scopeAppliedLive: true, clearsBindings: false }),
    ).toBe(liveNarrowedDetail);
    expect(
      scopeResponseDetail({ scopeSecretsChanged: true, narrowedSecrets: true, scopeAppliedLive: false, clearsBindings: false }),
    ).toBe(nextPromptNarrowedDetail);
    expect(
      scopeResponseDetail({ scopeSecretsChanged: true, narrowedSecrets: false, scopeAppliedLive: true, clearsBindings: false }),
    ).toBe(liveAppliedDetail);
    expect(
      scopeResponseDetail({ scopeSecretsChanged: true, narrowedSecrets: false, scopeAppliedLive: false, clearsBindings: false }),
    ).toBe(nextPromptAppliedDetail);
    expect(
      scopeResponseDetail({ scopeSecretsChanged: false, narrowedSecrets: false, scopeAppliedLive: false, clearsBindings: true }),
    ).toBe(clearsDetail);
    expect(
      scopeResponseDetail({ scopeSecretsChanged: false, narrowedSecrets: false, scopeAppliedLive: false, clearsBindings: false }),
    ).toBe(noChangeDetail);
  });
});
