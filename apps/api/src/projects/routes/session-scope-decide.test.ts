/**
 * Characterization of the `PUT …/sessions/{sessionId}/scope` decision helpers.
 *
 * `session-scope.ts` is a `projectsApp.openapi(...)` registration with no
 * per-route export, so the route cannot be stood up without the whole API and a
 * live database. The re-scope handler was split so its decisions are callable:
 * `decideSecretsRescope` (DB collaborators mocked here), `scopeResponseDetail`
 * and `buildScopeResponse`. These tests pin the CURRENT behaviour; they pass
 * before and after the split.
 *
 * The live-DB route characterization (a real PUT scope envelope over Postgres)
 * lives in the DB suites, which cannot run in a sandbox without Docker.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realAccess from '../lib/access';
import * as realPersonalResources from '../lib/personal-resources';
import * as realSecrets from '../secrets';

// `projectCapabilityAllowed` gates whether dropped secret NAMES are echoed.
let canReadSecretNames = true;
mock.module('../lib/access', () => ({
  ...realAccess,
  projectCapabilityAllowed: async () => canReadSecretNames,
}));

// The secrets decision resolves the SESSION OWNER, not the caller.
mock.module('../lib/personal-resources', () => ({
  ...realPersonalResources,
  resolveSessionPersonalOwner: async () => 'owner-user',
}));

// The identifiers the session owner can actually receive, and the collision probe.
let availableSecrets: Array<{ identifier: string; key: string }> = [];
let collision: { key: string; identifiers: string[] } | null = null;
mock.module('../secrets', () => ({
  ...realSecrets,
  listResolvedProjectSecrets: async () => availableSecrets,
  secretKeyCollisionInAllowlist: () => collision,
}));

const { buildScopeResponse, scopeResponseDetail, decideSecretsRescope, decideBindingsRescope } =
  await import('./session-scope');

function bindingsCtx(overrides: Record<string, unknown> = {}) {
  return {
    c: fakeC,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    loaded: { userId: 'caller-user', row: { accountId: 'acct-1' } },
    visible: { row: { createdBy: 'owner-user', visibility: 'project' } },
    grant: { env: 'all', connectors: 'all' },
    body: { connector_bindings: {} },
    wantsSecrets: false,
    wantsBindings: true,
    clearsBindings: false,
    currentDurableBindings: {},
    currentEffectiveBindings: {},
    currentEffectiveBindingIds: {},
    ...overrides,
  } as never;
}

const DROPPED_LIVE =
  'Dropped secrets are cleared from the running sandbox now; new shells and the OpenCode process no longer see them. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.';
const DROPPED_DEFERRED =
  'Dropped secrets stop being delivered from the next prompt. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.';
const APPLIED_LIVE =
  'Applied to the running sandbox now — the OpenCode process and new shells see the new scope.';
const APPLIED_DEFERRED = 'Applies from the next prompt.';
const BINDINGS_CLEARED = 'Connector access is back to the project defaults.';
const NO_CHANGE = 'No change to the secrets scope.';

/** A fake Hono context: `c.json` returns a real Response so `instanceof` works. */
const fakeC = {
  json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
} as never;

const visible = {
  row: {
    secretsAllowlist: null as string[] | null,
    sessionId: 'sess-1',
    createdBy: 'owner-user',
    connectorBindingsConfigured: false,
    connectorBindingsInheritUnbound: false,
  },
} as never;

function secretsCtx(overrides: Record<string, unknown> = {}) {
  return {
    c: fakeC,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    loaded: { userId: 'caller-user', row: { accountId: 'acct-1' } },
    visible,
    grant: { env: 'all', connectors: 'all' },
    body: { secrets: ['TEST_KEY_A'] },
    wantsSecrets: true,
    ...overrides,
  } as never;
}

beforeEach(() => {
  canReadSecretNames = true;
  availableSecrets = [];
  collision = null;
});

describe('scopeResponseDetail — the one detail string', () => {
  const base = { scopeSecretsChanged: true, narrowedSecrets: false, scopeAppliedLive: false, clearsBindings: false };

  test('narrowed + applied live', () => {
    expect(scopeResponseDetail({ ...base, narrowedSecrets: true, scopeAppliedLive: true })).toBe(
      DROPPED_LIVE,
    );
  });
  test('narrowed + deferred', () => {
    expect(scopeResponseDetail({ ...base, narrowedSecrets: true })).toBe(DROPPED_DEFERRED);
  });
  test('added only + applied live', () => {
    expect(scopeResponseDetail({ ...base, scopeAppliedLive: true })).toBe(APPLIED_LIVE);
  });
  test('added only + deferred', () => {
    expect(scopeResponseDetail(base)).toBe(APPLIED_DEFERRED);
  });
  test('an unchanged secrets scope that clears bindings reports the bindings outcome', () => {
    expect(
      scopeResponseDetail({
        ...base,
        scopeSecretsChanged: false,
        clearsBindings: true,
      }),
    ).toBe(BINDINGS_CLEARED);
  });
  test('a request that changed neither axis reports no change', () => {
    expect(scopeResponseDetail({ ...base, scopeSecretsChanged: false })).toBe(NO_CHANGE);
  });
});

describe('buildScopeResponse — the PUT scope envelope', () => {
  const decided = {
    nextAllowlist: ['TEST_KEY_B'],
    effectiveBindings: {},
    canReadSecretNames: true,
    droppedSecrets: ['TEST_KEY_A'],
    addedSecrets: [],
    droppedBindings: [],
    wantsBindings: false,
    clearsBindings: false,
    visible,
    narrowedSecrets: true,
    scopeSecretsChanged: true,
    scopeAppliedLive: true,
    scopePushFailed: false,
    scopePushReason: undefined,
  };

  test('a secrets-only narrowing: dropped, added, retroactive, applied_live, detail', () => {
    expect(buildScopeResponse({ ...decided })).toEqual({
      secrets_allowlist: ['TEST_KEY_B'],
      required_connectors: null,
      connector_bindings: {},
      dropped_secrets: ['TEST_KEY_A'],
      added_secrets: [],
      dropped_bindings: [],
      connector_bindings_configured: false,
      connector_bindings_inherit_unbound: false,
      retroactive: false,
      applied_live: true,
      detail: DROPPED_LIVE,
    });
  });

  test('a deferred narrowing is not retroactive', () => {
    const body = buildScopeResponse({ ...decided, scopeAppliedLive: false });
    expect(body.retroactive).toBe(false);
    expect(body.applied_live).toBe(false);
    expect(body.detail).toBe(DROPPED_DEFERRED);
  });

  test('a secrets-only ADDITION is retroactive', () => {
    const body = buildScopeResponse({
      ...decided,
      nextAllowlist: ['TEST_KEY_A', 'TEST_KEY_B'],
      droppedSecrets: [],
      addedSecrets: ['TEST_KEY_B'],
      narrowedSecrets: false,
      scopeAppliedLive: false,
    });
    expect(body.retroactive).toBe(true);
    expect(body.added_secrets).toEqual(['TEST_KEY_B']);
    expect(body.detail).toBe(APPLIED_DEFERRED);
  });

  test('without project.secret.read the dropped NAMES are withheld, the warning is not', () => {
    const body = buildScopeResponse({ ...decided, canReadSecretNames: false });
    expect(body.dropped_secrets).toEqual([]);
    expect(body.retroactive).toBe(false);
    expect(body.detail).toBe(DROPPED_LIVE);
  });

  test('a failed live push surfaces push_failed and its reason', () => {
    const body = buildScopeResponse({
      ...decided,
      scopeAppliedLive: false,
      scopePushFailed: true,
      scopePushReason: 'daemon unreachable',
    });
    expect(body.push_failed).toBe(true);
    expect(body.push_reason).toBe('daemon unreachable');
  });

  test('echoes the connector-binding flags, and a bindings write marks it configured', () => {
    const configured = buildScopeResponse({
      ...decided,
      wantsBindings: true,
      clearsBindings: false,
      scopeSecretsChanged: false,
      narrowedSecrets: false,
      droppedSecrets: [],
    });
    expect(configured.connector_bindings_configured).toBe(true);
    expect(configured.detail).toBe(NO_CHANGE);

    const cleared = buildScopeResponse({
      ...decided,
      wantsBindings: true,
      clearsBindings: true,
      scopeSecretsChanged: false,
      narrowedSecrets: false,
      droppedSecrets: [],
    });
    expect(cleared.connector_bindings_configured).toBe(false);
    expect(cleared.detail).toBe(BINDINGS_CLEARED);
  });
});

describe('decideSecretsRescope (DB collaborators mocked)', () => {
  test('a narrowing reports dropped, added and narrowed, and reads names when allowed', async () => {
    availableSecrets = [{ identifier: 'TEST_KEY_B', key: 'TEST_KEY_B' }];
    const result = await decideSecretsRescope(
      secretsCtx({
        visible: {
          row: {
            secretsAllowlist: ['TEST_KEY_A', 'TEST_KEY_B'],
            sessionId: 'sess-1',
            createdBy: 'owner-user',
          },
        },
        body: { secrets: ['TEST_KEY_B'] },
      }),
    );
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) return;
    expect(result.nextAllowlist).toEqual(['TEST_KEY_B']);
    expect(result.droppedSecrets).toEqual(['TEST_KEY_A']);
    expect(result.addedSecrets).toEqual([]);
    expect(result.narrowedSecrets).toBe(true);
    expect(result.canReadSecretNames).toBe(true);
  });

  test('without project.secret.read the names are withheld but narrowed still holds', async () => {
    canReadSecretNames = false;
    availableSecrets = [{ identifier: 'TEST_KEY_B', key: 'TEST_KEY_B' }];
    const result = await decideSecretsRescope(
      secretsCtx({
        visible: {
          row: {
            secretsAllowlist: ['TEST_KEY_A', 'TEST_KEY_B'],
            sessionId: 'sess-1',
            createdBy: 'owner-user',
          },
        },
        body: { secrets: ['TEST_KEY_B'] },
      }),
    );
    if (result instanceof Response) throw new Error('unexpected refusal');
    expect(result.canReadSecretNames).toBe(false);
    expect(result.narrowedSecrets).toBe(true);
  });

  test('an identifier the owner cannot receive is refused 403 SECRET_IDENTIFIER_NOT_AVAILABLE', async () => {
    availableSecrets = [];
    const result = await decideSecretsRescope(secretsCtx());
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({
      error: 'secret identifier is not available: TEST_KEY_A',
      code: 'SECRET_IDENTIFIER_NOT_AVAILABLE',
    });
  });

  test('two identifiers for one env key are refused 409 SECRET_IDENTIFIER_KEY_COLLISION', async () => {
    availableSecrets = [{ identifier: 'TEST_KEY_A', key: 'SAME_KEY' }];
    collision = { key: 'SAME_KEY', identifiers: ['TEST_KEY_A', 'TEST_KEY_A2'] };
    const result = await decideSecretsRescope(secretsCtx());
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(409);
    expect(((await result.json()) as { code: string }).code).toBe(
      'SECRET_IDENTIFIER_KEY_COLLISION',
    );
  });

  test('an identifier outside the agent grant is refused 403 NOT_IN_AGENT_GRANT', async () => {
    const result = await decideSecretsRescope(
      secretsCtx({ grant: { env: ['TEST_KEY_A'], connectors: 'all' }, body: { secrets: ['TEST_KEY_Z'] } }),
    );
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(403);
    expect(((await result.json()) as { code: string }).code).toBe('NOT_IN_AGENT_GRANT');
  });

  test('a request without `secrets` is a no-op that keeps the stored allowlist', async () => {
    const result = await decideSecretsRescope(
      secretsCtx({ wantsSecrets: false, visible: { row: { secretsAllowlist: ['TEST_KEY_A'], sessionId: 'sess-1', createdBy: 'owner-user' } } }),
    );
    if (result instanceof Response) throw new Error('unexpected refusal');
    expect(result.nextAllowlist).toEqual(['TEST_KEY_A']);
    expect(result.narrowedSecrets).toBe(false);
    expect(result.canReadSecretNames).toBe(false);
  });

  test('the decision feeds the envelope: a secrets-only narrowing end to end', async () => {
    availableSecrets = [{ identifier: 'TEST_KEY_B', key: 'TEST_KEY_B' }];
    const ctx = secretsCtx({
      visible: {
        row: {
          secretsAllowlist: ['TEST_KEY_A', 'TEST_KEY_B'],
          sessionId: 'sess-1',
          createdBy: 'owner-user',
          connectorBindingsConfigured: false,
          connectorBindingsInheritUnbound: false,
        },
      },
      body: { secrets: ['TEST_KEY_B'] },
    });
    const decision = await decideSecretsRescope(ctx);
    if (decision instanceof Response) throw new Error('unexpected refusal');
    const body = buildScopeResponse({
      ...decision,
      effectiveBindings: {},
      droppedBindings: [],
      wantsBindings: false,
      clearsBindings: false,
      visible,
      scopeSecretsChanged: true,
      scopeAppliedLive: true,
      scopePushFailed: false,
      scopePushReason: undefined,
    });
    expect(body).toMatchObject({
      secrets_allowlist: ['TEST_KEY_B'],
      dropped_secrets: ['TEST_KEY_A'],
      added_secrets: [],
      retroactive: false,
      applied_live: true,
      detail: DROPPED_LIVE,
    });
  });
});

describe('decideBindingsRescope (pure decision paths)', () => {
  test('a `null` connector_bindings clears every stored row without validating', async () => {
    const result = await decideBindingsRescope(
      bindingsCtx({ clearsBindings: true, currentDurableBindings: { TEST_ALIAS: 'conn-1' } }),
    );
    if (result instanceof Response) throw new Error('unexpected refusal');
    expect(result.nextBindings).toEqual({});
    expect(result.bindingRows).toEqual([]);
  });

  test('binding an alias the agent is not granted is refused 403 NOT_GRANTED_CONNECTOR', async () => {
    const result = await decideBindingsRescope(
      bindingsCtx({
        grant: { env: 'all', connectors: ['TEST_ALIAS_GRANTED'] },
        body: { connector_bindings: { TEST_ALIAS_OTHER: { connection_id: 'conn-1' } } },
      }),
    );
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(403);
    expect(((await result.json()) as { code: string }).code).toBe('NOT_GRANTED_CONNECTOR');
  });
});
