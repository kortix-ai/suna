/**
 * Characterization pins for `PUT /{projectId}/sessions/{sessionId}/scope`.
 *
 * Runs the real route against a local OpenAPIHono with every collaborator
 * mocked at its module seam (no PostgreSQL, no sandbox): access, agent grant,
 * connector-binding resolution/validation, project secrets, and the sandbox
 * push. The pins hold the exact response envelope — status, error codes,
 * `dropped_secrets` / `added_secrets` / `retroactive` / `applied_live` and the
 * exact `detail` strings — so a structural refactor of the handler cannot move
 * behavior. The same file passed before and after the decision-helper
 * extraction; the fully-real-DB behavior is covered by the REST flow lane
 * (`tests/src/flows/secrets.flow.ts`), which needs a live stack.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { projectSessionConnectorBindings, projectSessions, serviceAccounts } from '@kortix/db';

const accountId = '10000000-0000-4000-8000-000000000000';
const projectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const ownerId = '55555555-5555-4555-8555-555555555555';
const callerId = '44444444-4444-4444-8444-444444444444';
const base = `/${projectId}/sessions/${sessionId}/scope`;
const connId1 = 'c1111111-1111-4111-8111-111111111111';
const connId2 = 'c2222222-2222-4222-8222-222222222222';

/** The session row as `loadVisibleSession` returns it. */
let sessionRow: {
  secretsAllowlist: string[] | null;
  connectorBindingsConfigured: boolean;
  connectorBindingsInheritUnbound: boolean;
  visibility: 'private' | 'project';
  createdBy: string | null;
};
let agentGrant: { env: string[] | 'all'; connectors: string[] | 'all' } | null = null;
let grantThrows = false;
/** Stored session-binding rows, keyed by alias. */
let durableBindings: Record<string, string> = {};
/** What the (mocked) resolver answers before and after the write+invalidate. */
let effectiveBefore: Record<string, { connection_id: string }> = {};
let effectiveAfter: Record<string, { connection_id: string }> = {};
let invalidated = false;
/** Secrets the (mocked) project secret store can resolve for the session owner. */
let availableSecretRows: Array<{
  secretId: string;
  identifier: string;
  key: string;
  value: string;
}> = [];
let canReadSecretNames = false;
/** Validated bindings that count as personal (private-visibility) connections. */
let personalAliases = new Set<string>();
let validateError: { ok: false; error: string; code: string } | null = null;
let ownerServiceAccountExists = false;
let pushResult: { applied: boolean; reason?: string } = { applied: true };
let pushCalls = 0;
let sessionUpdates: Array<Record<string, unknown>> = [];
let insertedBindings: Array<Record<string, unknown>> = [];
let bindingDeletes = 0;

beforeEach(() => {
  sessionRow = {
    secretsAllowlist: null,
    connectorBindingsConfigured: false,
    connectorBindingsInheritUnbound: true,
    visibility: 'private',
    createdBy: ownerId,
  };
  agentGrant = null;
  grantThrows = false;
  durableBindings = {};
  effectiveBefore = {};
  effectiveAfter = {};
  invalidated = false;
  availableSecretRows = [];
  canReadSecretNames = false;
  personalAliases = new Set();
  validateError = null;
  ownerServiceAccountExists = false;
  pushResult = { applied: true };
  pushCalls = 0;
  sessionUpdates = [];
  insertedBindings = [];
  bindingDeletes = 0;
});

const app = new OpenAPIHono<any>();
app.use('*', async (c, next) => {
  c.set('authType', 'supabase');
  c.set('sessionId', 'browser-login');
  await next();
});

mock.module('../lib/app', () => ({ projectsApp: app }));
mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: callerId,
    row: {
      accountId,
      metadata: {},
      repoUrl: 'https://example.test/repo',
      defaultBranch: null,
      manifestPath: null,
    },
  }),
  assertProjectCapability: async () => {},
  projectCapabilityAllowed: async () => canReadSecretNames,
  loadVisibleSession: async () => ({
    row: { ...sessionRow },
    canManageLifecycle: true,
    ownerIsMachine: false,
  }),
}));
const realMirror = await import('../../services/git/mirror');
let staleReadCalls = 0;
mock.module('../../services/git/mirror', () => ({
  ...realMirror,
  allowStaleMirrorReads: () => {
    staleReadCalls++;
  },
}));
const realSecretGrant = await import('../../services/secrets/secret-grant');
mock.module('../../services/secrets/secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionAgentGrant: async () => {
    if (grantThrows) throw new Error('manifest unreadable');
    return agentGrant;
  },
}));
mock.module('../lib/personal-resources', () => ({
  resolveSessionPersonalOwner: async () => ownerId,
}));
const realSecrets = await import('../../services/secrets/secrets');
mock.module('../../services/secrets/secrets', () => ({
  ...realSecrets,
  listResolvedProjectSecrets: async () => availableSecretRows,
}));
const realEnvSync = await import('../../services/sandboxes/sandbox-env-sync');
mock.module('../../services/sandboxes/sandbox-env-sync', () => ({
  ...realEnvSync,
  pushSessionScopeToSandbox: async () => {
    pushCalls++;
    return pushResult;
  },
  pushSessionModelToSandbox: async () => ({ ok: true }),
}));
const realScb = await import('../../services/sessions/session-connector-bindings');
mock.module('../../services/sessions/session-connector-bindings', () => ({
  ...realScb,
  resolveEffectiveSessionConnectorBindings: async () =>
    invalidated ? effectiveAfter : effectiveBefore,
  validateSessionConnectorBindings: async (input: {
    bindings?: Record<string, { connection_id: string }>;
  }) => {
    if (validateError) return validateError;
    const bindings = Object.entries(input.bindings ?? {}).map(([alias, value]) => ({
      alias,
      connectorId: `connector-${alias}`,
      connectionId: value.connection_id,
      personal: personalAliases.has(alias),
    }));
    return { ok: true, bindings };
  },
  invalidateSessionConnectorLookup: () => {
    invalidated = true;
  },
}));
mock.module('../../feature-flags/registry', () => ({
  resolveFeatureFlag: () => true,
}));
mock.module('../../llm-gateway/enablement', () => ({ projectLlmGatewayEnabled: () => true }));
const realEntitlements = await import('../../billing/services/entitlements');
mock.module('../../billing/services/entitlements', () => ({
  ...realEntitlements,
  accountMayUseManagedModels: async () => true,
}));

const fakeDb: any = {
  select: () => ({
    from: (table: unknown) => {
      const rows =
        table === serviceAccounts
          ? ownerServiceAccountExists
            ? [{ serviceAccountId: 'sa-1' }]
            : []
          : table === projectSessionConnectorBindings
            ? Object.entries(durableBindings).map(([alias, connectionId]) => ({
                alias,
                connectionId,
              }))
            : (() => {
                throw new Error('unexpected select table');
              })();
      // The route awaits the bindings select directly and chains `.limit(1)`
      // on the service-account select; shape each to match, like drizzle does.
      if (table === serviceAccounts) {
        return { where: () => ({ limit: (n: number) => rows.slice(0, n) }) };
      }
      return { where: () => Promise.resolve(rows) };
    },
  }),
  update: (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        if (table !== projectSessions) throw new Error('unexpected update table');
        sessionUpdates.push(values);
      },
    }),
  }),
  delete: (table: unknown) => ({
    where: async () => {
      if (table !== projectSessionConnectorBindings) throw new Error('unexpected delete table');
      bindingDeletes++;
      durableBindings = {};
    },
  }),
  insert: (table: unknown) => ({
    values: async (rows: Array<Record<string, unknown>>) => {
      if (table !== projectSessionConnectorBindings) throw new Error('unexpected insert table');
      insertedBindings.push(...rows);
    },
  }),
  transaction: async (fn: (tx: unknown) => Promise<void>) => fn(fakeDb),
};
mock.module('../../lib/db', () => ({ db: fakeDb }));

(await import('./session-scope')).registerSessionScopeRoutes();

const putScope = (body: unknown) =>
  app.request(base, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('PUT scope — secrets-only narrowing envelope', () => {
  test('null → list narrowing under an "all" grant: no droppable names, warning still fires', async () => {
    sessionRow.secretsAllowlist = null;
    agentGrant = { env: 'all', connectors: 'all' };
    availableSecretRows = [
      { secretId: 's1', identifier: 'GMAIL_TOKEN', key: 'GMAIL_TOKEN', value: 'v' },
    ];
    pushResult = { applied: true };
    const response = await putScope({ secrets: ['GMAIL_TOKEN'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      secrets_allowlist: ['GMAIL_TOKEN'],
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: false,
      connector_bindings_configured: false,
      connector_bindings_inherit_unbound: true,
      applied_live: true,
      detail:
        'Dropped secrets are cleared from the running sandbox now; new shells and the OpenCode process no longer see them. ' +
        'Values the agent already read remain in its context and in shells it already started — rotate them if that matters.',
    });
    expect(pushCalls).toBe(1);
    expect(sessionUpdates).toEqual([
      { updatedAt: expect.any(Date), secretsAllowlist: ['GMAIL_TOKEN'] },
    ]);
  });

  test('narrowing away a named secret echoes the name only to a caller that may read secret names', async () => {
    sessionRow.secretsAllowlist = ['A_SECRET', 'B_SECRET'];
    agentGrant = { env: ['A_SECRET', 'B_SECRET'], connectors: 'all' };
    availableSecretRows = [{ secretId: 's1', identifier: 'A_SECRET', key: 'A_SECRET', value: 'v' }];
    pushResult = { applied: false };
    const response = await putScope({ secrets: ['A_SECRET'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      secrets_allowlist: ['A_SECRET'],
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: false,
      connector_bindings_configured: false,
      connector_bindings_inherit_unbound: true,
      applied_live: false,
      push_failed: true,
      detail:
        'Dropped secrets stop being delivered from the next prompt. ' +
        'Values the agent already read remain in its context and in shells it already started — rotate them if that matters.',
    });
    expect(pushCalls).toBe(1);
    canReadSecretNames = true;
    const readable = await putScope({ secrets: ['A_SECRET'] });
    expect((await readable.json()).dropped_secrets).toEqual(['B_SECRET']);
  });

  test('added-only change is retroactive-safe and reports the applied sandbox push', async () => {
    sessionRow.secretsAllowlist = ['A_SECRET'];
    agentGrant = { env: 'all', connectors: 'all' };
    availableSecretRows = [
      { secretId: 's1', identifier: 'A_SECRET', key: 'A_SECRET', value: 'v' },
      { secretId: 's2', identifier: 'C_SECRET', key: 'C_SECRET', value: 'v' },
    ];
    const response = await putScope({ secrets: ['A_SECRET', 'C_SECRET'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dropped_secrets).toEqual([]);
    expect(body.added_secrets).toEqual(['C_SECRET']);
    expect(body.retroactive).toBe(true);
    expect(body.applied_live).toBe(true);
    expect(body.detail).toBe(
      'Applied to the running sandbox now — the OpenCode process and new shells see the new scope.',
    );
  });

  test('a no-op allowlist write neither pushes nor changes the scope', async () => {
    sessionRow.secretsAllowlist = ['A_SECRET'];
    agentGrant = { env: 'all', connectors: 'all' };
    availableSecretRows = [{ secretId: 's1', identifier: 'A_SECRET', key: 'A_SECRET', value: 'v' }];
    const response = await putScope({ secrets: ['A_SECRET'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied_live).toBe(false);
    expect(body.retroactive).toBe(true);
    expect(body.detail).toBe('No change to the secrets scope.');
    expect(pushCalls).toBe(0);
  });

  test('a failed sandbox push surfaces push_failed and push_reason', async () => {
    sessionRow.secretsAllowlist = null;
    agentGrant = { env: 'all', connectors: 'all' };
    availableSecretRows = [
      { secretId: 's1', identifier: 'GMAIL_TOKEN', key: 'GMAIL_TOKEN', value: 'v' },
    ];
    pushResult = { applied: false, reason: 'box stopped' };
    const response = await putScope({ secrets: ['GMAIL_TOKEN'] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied_live).toBe(false);
    expect(body.push_failed).toBe(true);
    expect(body.push_reason).toBe('box stopped');
  });
});

describe('PUT scope — secrets decision refusals', () => {
  test('an identifier the project cannot resolve is refused with 403', async () => {
    sessionRow.secretsAllowlist = null;
    agentGrant = { env: 'all', connectors: 'all' };
    availableSecretRows = [];
    const response = await putScope({ secrets: ['GMAIL_TOKEN'] });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'secret identifier is not available: GMAIL_TOKEN',
      code: 'SECRET_IDENTIFIER_NOT_AVAILABLE',
    });
  });

  test('two identifiers mapping to one env key collide with 409', async () => {
    sessionRow.secretsAllowlist = null;
    agentGrant = { env: 'all', connectors: 'all' };
    availableSecretRows = [
      { secretId: 's1', identifier: 'GMAIL_TOKEN', key: 'GMAIL_TOKEN', value: 'v' },
      { secretId: 's2', identifier: 'GMAIL_TOKEN_ALT', key: 'GMAIL_TOKEN', value: 'v' },
    ];
    const response = await putScope({ secrets: ['GMAIL_TOKEN', 'GMAIL_TOKEN_ALT'] });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('SECRET_IDENTIFIER_KEY_COLLISION');
    expect(body.error).toBe(
      'secrets allowlist names multiple identifiers for env key "GMAIL_TOKEN": GMAIL_TOKEN, GMAIL_TOKEN_ALT',
    );
  });

  test('a secret outside the agent grant is refused with 403', async () => {
    sessionRow.secretsAllowlist = null;
    agentGrant = { env: ['A_SECRET'], connectors: 'all' };
    const response = await putScope({ secrets: ['GMAIL_TOKEN'] });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('NOT_IN_AGENT_GRANT');
    expect(body.error).toBe(
      "not in this agent's secrets grant: GMAIL_TOKEN — a session may narrow within the grant, never past it",
    );
  });

  test('a body violating the schema is rejected 400 by the OpenAPI body validator', async () => {
    const response = await putScope({ secrets: 42 });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        issues: [
          {
            code: 'invalid_type',
            expected: 'array',
            received: 'number',
            path: ['secrets'],
            message: 'Expected array, received number',
          },
        ],
        name: 'ZodError',
      },
    });
  });
});

describe('PUT scope — connector bindings decision', () => {
  test('an explicit override persists validated rows and echoes configured=true', async () => {
    effectiveBefore = {};
    effectiveAfter = { gmail: { connection_id: connId1 } };
    const response = await putScope({ connector_bindings: { gmail: { connection_id: connId1 } } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connector_bindings).toEqual({ gmail: { connection_id: connId1 } });
    expect(body.connector_bindings_configured).toBe(true);
    expect(body.connector_bindings_inherit_unbound).toBe(true);
    expect(body.dropped_bindings).toEqual([]);
    expect(body.detail).toBe('No change to the secrets scope.');
    expect(body.applied_live).toBe(false);
    expect(pushCalls).toBe(0);
    expect(bindingDeletes).toBe(1);
    expect(insertedBindings).toEqual([
      {
        sessionId,
        projectId,
        accountId,
        connectorAlias: 'gmail',
        connectorId: 'connector-gmail',
        connectionId: connId1,
        source: 'request',
        createdBy: callerId,
      },
    ]);
    expect(sessionUpdates).toEqual([
      { updatedAt: expect.any(Date), connectorBindingsConfigured: true },
    ]);
  });

  test('null clears the override: stored rows go and the session inherits again', async () => {
    durableBindings = { gmail: connId1 };
    effectiveBefore = { gmail: { connection_id: connId1 } };
    effectiveAfter = {};
    const response = await putScope({ connector_bindings: null });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.connector_bindings).toEqual({});
    expect(body.connector_bindings_configured).toBe(false);
    expect(body.dropped_bindings).toEqual(['gmail']);
    expect(body.detail).toBe('Connector access is back to the project defaults.');
    expect(bindingDeletes).toBe(1);
    expect(insertedBindings).toEqual([]);
    expect(sessionUpdates).toEqual([
      { updatedAt: expect.any(Date), connectorBindingsConfigured: false },
    ]);
  });

  test('binding an alias the agent grant does not list is refused with 403', async () => {
    agentGrant = { env: 'all', connectors: ['slack'] };
    const response = await putScope({ connector_bindings: { gmail: { connection_id: connId1 } } });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('NOT_GRANTED_CONNECTOR');
    expect(body.error).toBe(
      'not granted to this agent: gmail — binding an alias the manifest does not grant would 403 at the first tool call',
    );
  });

  test('a personal connection on a non-private session is refused with 409', async () => {
    personalAliases = new Set(['gmail']);
    sessionRow.visibility = 'project';
    effectiveAfter = { gmail: { connection_id: connId1 } };
    const response = await putScope({ connector_bindings: { gmail: { connection_id: connId1 } } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'A user authorization requires a private session',
      code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
    });
  });

  test('a validation refusal passes its own error and code through', async () => {
    validateError = {
      ok: false,
      error: 'connection c1 is not usable',
      code: 'CONNECTION_NOT_USABLE',
    };
    const response = await putScope({ connector_bindings: { gmail: { connection_id: connId1 } } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'connection c1 is not usable',
      code: 'CONNECTION_NOT_USABLE',
    });
  });

  test('an alias absent after the write is reported in dropped_bindings', async () => {
    durableBindings = { gmail: connId1, sheets: connId2 };
    effectiveBefore = { gmail: { connection_id: connId1 }, sheets: { connection_id: connId2 } };
    effectiveAfter = { gmail: { connection_id: connId1 } };
    const response = await putScope({ connector_bindings: { gmail: { connection_id: connId1 } } });
    expect(response.status).toBe(200);
    expect((await response.json()).dropped_bindings).toEqual(['sheets']);
  });
});

describe('GET scope — page-view git reads', () => {
  test('allows the warm-mirror read path before resolving the agent grant', async () => {
    staleReadCalls = 0;
    const response = await app.request(base);
    expect(response.status).toBe(200);
    expect(staleReadCalls).toBe(1);
  });
});
