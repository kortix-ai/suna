import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  projectSecrets,
  projectSessionSecretHandles,
  projectSessions,
  sessionSandboxes,
} from '@kortix/db';
import { Hono } from 'hono';
import { config } from '../config';
import * as realAccess from '../projects/lib/access';
import * as realProjectSecrets from '../projects/secrets';
import { mintHandle } from '../secrets/strategy';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const SECRET_ID = '66666666-6666-4666-8666-666666666666';
const POLICY = {
  backend: 'kortix_fetch' as const,
  rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
  inject: { kind: 'header' as const, name: 'authorization', template: 'Bearer {{secret}}' },
};
const SECOND_SECRET_ID = '88888888-8888-4888-8888-888888888888';
const PRIMARY_LOOKUP_ID = 'aaaaaaaaaaaaaaaaaaaa';
const SECOND_LOOKUP_ID = 'bbbbbbbbbbbbbbbbbbbb';
const FROZEN_POLICY = {
  backend: 'kortix_fetch' as const,
  rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
  inject: { kind: 'header' as const, name: 'x-api-key' },
};

let authType: 'pat' | 'supabase' = 'pat';
let tokenProjectId: string | undefined = PROJECT_ID;
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
/** The handle rows the SESSION holds — the route reads all of them now, so it
 *  can substitute every secret this destination admits, not only its own. */
function handleFor(overrides: Record<string, unknown> = {}) {
  const lookupId = (overrides.lookupId as string) ?? PRIMARY_LOOKUP_ID;
  const handle = mintHandle({ lookupId, prefix: null, rootSecret: config.API_KEY_SECRET });
  return {
    secretId: SECRET_ID,
    identifier: 'PRIMARY',
    lookupId,
    handleHash: createHash('sha256').update(handle).digest('hex'),
    policySnapshot: FROZEN_POLICY,
    expiresAt: null,
    ...overrides,
  };
}

let handleRows: Array<Record<string, unknown>> = [];
let secretRows: Array<Record<string, unknown>> = [];
const audits: Array<Record<string, unknown>> = [];
const decrypted: string[] = [];
const brokerCalls: Array<{
  policy: unknown;
  secret: string;
  input: unknown;
  substitutions: unknown[];
}> = [];
let brokerFailure: Error | null = null;

function sharedSecret(overrides: Record<string, unknown> = {}) {
  return {
    secretId: SECRET_ID,
    identifier: 'PRIMARY',
    ownerUserId: null,
    valueEnc: 'shared-encrypted-value',
    active: true,
    strategy: 'broker',
    egressPolicy: POLICY,
    handlePrefix: null,
    ...overrides,
  };
}

/** `null` = no pin recorded. Set `{ metadata: { egress_ip: '…' } }` to pin. */
let sandboxRow: { metadata: Record<string, unknown> } | null = null;

const databaseMock = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === projectSessions)
          return { limit: async () => (sessionRow ? [sessionRow] : []) };
        // The egress pin reads the sandbox row to see whether this token is
        // being used from the box it was issued to. `sandboxRow` is null by
        // default, i.e. UNPINNED — which the route must allow, or every session
        // provisioned before the pin shipped would lose its secrets.
        if (table === sessionSandboxes) {
          return { limit: async () => (sandboxRow ? [sandboxRow] : []) };
        }
        if (table === projectSecrets) return Promise.resolve(secretRows);
        // The route reads EVERY active handle of the session (revision
        // descending) instead of one row for one secret.
        if (table === projectSessionSecretHandles) {
          return { orderBy: async () => handleRows };
        }
        throw new Error('unexpected table');
      },
    }),
  }),
};

mock.module('../shared/db', () => ({ db: databaseMock, hasDatabase: true }));
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: USER_ID,
  }),
}));
mock.module('../projects/secrets', () => ({
  ...realProjectSecrets,
  decryptProjectSecret: (_projectId: string, value: string) => {
    decrypted.push(value);
    if (value === 'personal-encrypted-value') return 'personal-secret-value';
    if (value === 'second-encrypted-value') return 'second-secret-value';
    return 'shared-secret-value';
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
  executeSecretBrokerRequest: async (
    policy: unknown,
    secret: string,
    input: unknown,
    options?: { substitutions?: unknown[]; applied?: Set<string> },
  ) => {
    brokerCalls.push({ policy, secret, input, substitutions: options?.substitutions ?? [] });
    for (const entry of (options?.substitutions ?? []) as Array<{ identifier: string }>) {
      options?.applied?.add(entry.identifier);
    }
    if (brokerFailure) throw brokerFailure;
    return {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body_base64: Buffer.from('{"ok":true}').toString('base64'),
    };
  },
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/secret-broker');

function buildApp() {
  const app = new Hono<{
    Variables: {
      userId: string;
      authType: 'pat' | 'supabase';
      tokenProjectId?: string;
      sessionId?: string;
      sandboxId?: string;
      sessionRuntimeKind?: 'worker' | 'environment';
      agentGrant?: Record<string, unknown> | null;
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', authType);
    if (tokenProjectId) c.set('tokenProjectId', tokenProjectId);
    if (sessionId) {
      c.set('sessionId', sessionId);
      c.set('sandboxId', sessionId);
      c.set('sessionRuntimeKind', 'worker');
    }
    c.set('agentGrant', agentGrant);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function brokerRequest(fromIp?: string, relayed: Record<string, unknown> = {}) {
  return buildApp().request(`/v1/projects/${PROJECT_ID}/secrets/PRIMARY/broker`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Cloudflare fronts this API and appends, so the FIRST hop is the caller.
      ...(fromIp ? { 'x-forwarded-for': `${fromIp}, 172.68.1.1` } : {}),
    },
    body: JSON.stringify({
      url: 'https://api.example.com/v1/messages?trace=private',
      method: 'POST',
      body_base64: Buffer.from('{}').toString('base64'),
      ...relayed,
    }),
  });
}

/** A second secret on the SAME host, with its own handle. */
function secondSecret(overrides: Record<string, unknown> = {}) {
  return sharedSecret({
    secretId: SECOND_SECRET_ID,
    identifier: 'SECOND',
    valueEnc: 'second-encrypted-value',
    strategy: 'egress',
    egressPolicy: { rules: [{ host: 'api.example.com' }] },
    ...overrides,
  });
}

function secondHandle(overrides: Record<string, unknown> = {}) {
  return handleFor({
    secretId: SECOND_SECRET_ID,
    identifier: 'SECOND',
    lookupId: SECOND_LOOKUP_ID,
    policySnapshot: { rules: [{ host: 'api.example.com' }] },
    ...overrides,
  });
}

function handleString(lookupId: string) {
  return mintHandle({ lookupId, prefix: null, rootSecret: config.API_KEY_SECRET });
}

describe('POST /v1/projects/:projectId/secrets/:identifier/broker', () => {
  beforeEach(() => {
    authType = 'pat';
    tokenProjectId = PROJECT_ID;
    sessionId = SESSION_ID;
    agentGrant = {
      agent: 'default',
      kortixCli: 'all',
      connectors: 'all',
      env: ['PRIMARY'],
    };
    sessionRow = { sessionId: SESSION_ID, secretsAllowlist: ['PRIMARY'] };
    handleRows = [handleFor()];
    secretRows = [sharedSecret()];
    audits.length = 0;
    decrypted.length = 0;
    brokerCalls.length = 0;
    brokerFailure = null;
    sandboxRow = null;
  });

  /**
   * The session token lives in the AGENT's own shell env (it needs it for the
   * CLI and git), so the agent can copy it out and hand it to someone else.
   * Everything else on this route checks what the token IS. These check where
   * it is being used FROM.
   */
  describe('the session credential is bound to its own sandbox', () => {
    test('a request from the pinned sandbox is served', async () => {
      sandboxRow = { metadata: { egress_ip: '67.213.121.131' } };
      const response = await brokerRequest('67.213.121.131');
      expect(response.status).toBe(200);
      expect(brokerCalls).toHaveLength(1);
    });

    test('the SAME token from anywhere else is refused before the secret is decrypted', async () => {
      sandboxRow = { metadata: { egress_ip: '67.213.121.131' } };
      const response = await brokerRequest('203.0.113.9');
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'sandbox_egress_mismatch' });
      // The point of refusing EARLY: an exfiltrated token must not reach the
      // decrypt path at all, not merely fail afterwards.
      expect(decrypted).toHaveLength(0);
      expect(brokerCalls).toHaveLength(0);
    });

    test('an UNPINNED session is still served', async () => {
      // Fails open on purpose. Sandboxes provisioned before the pin shipped
      // have none, and a boot relay that never landed would otherwise take a
      // working session's secrets away with a 403 nobody could diagnose.
      sandboxRow = null;
      const response = await brokerRequest('203.0.113.9');
      expect(response.status).toBe(200);
    });

    test('a caller with no resolvable address cannot pass a pinned session', async () => {
      // Absent != matching. Treating "unknown" as a match would let anyone
      // through by simply stripping the header.
      sandboxRow = { metadata: { egress_ip: '67.213.121.131' } };
      const response = await brokerRequest();
      expect(response.status).toBe(403);
      expect(brokerCalls).toHaveLength(0);
    });
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
    expect(
      audits.every((event) => JSON.stringify(event).includes('shared-secret-value') === false),
    ).toBe(true);
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
    handleRows = [];

    const response = await brokerRequest();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'session_secret_handle_required' });
    expect(decrypted).toHaveLength(0);
    expect(brokerCalls).toHaveLength(0);
  });

  test('an EXPIRED handle is not an active handle', async () => {
    handleRows = [handleFor({ expiresAt: new Date(Date.now() - 1_000) })];

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

  describe('server-side substitution', () => {
    // The egress-enforced path: the guest holds handles, the relay swaps them
    // for the real values. See
    // docs/specs/2026-08-19-secrets-exposure-usage-model.md §5.
    beforeEach(() => {
      agentGrant = {
        agent: 'default',
        kortixCli: 'all',
        connectors: 'all',
        env: ['PRIMARY', 'SECOND'],
      };
      sessionRow = { sessionId: SESSION_ID, secretsAllowlist: ['PRIMARY', 'SECOND'] };
      secretRows = [sharedSecret(), secondSecret()];
      handleRows = [handleFor(), secondHandle()];
    });

    test('two secrets on one host are both handed to the relay', async () => {
      const response = await brokerRequest();

      expect(response.status).toBe(200);
      expect(brokerCalls[0]?.substitutions).toEqual([
        {
          identifier: 'PRIMARY',
          handle: handleString(PRIMARY_LOOKUP_ID),
          value: 'shared-secret-value',
          policy: FROZEN_POLICY,
        },
        {
          identifier: 'SECOND',
          handle: handleString(SECOND_LOOKUP_ID),
          value: 'second-secret-value',
          policy: { rules: [{ host: 'api.example.com' }] },
        },
      ]);
      const completed = audits.find((event) => event.action === 'secret.broker.completed');
      expect(completed?.after).toMatchObject({ substituted: ['PRIMARY', 'SECOND'] });
    });

    test('a secret whose own policy denies this host is never decrypted', async () => {
      // Substitution must not widen who may spend: the destination is admitted
      // for the route's secret, not for this one.
      handleRows = [
        handleFor(),
        secondHandle({ policySnapshot: { rules: [{ host: 'elsewhere.example' }] } }),
      ];

      const response = await brokerRequest();

      expect(response.status).toBe(200);
      expect(
        (brokerCalls[0]?.substitutions as Array<{ identifier: string }>).map((s) => s.identifier),
      ).toEqual(['PRIMARY']);
      expect(decrypted).not.toContain('second-encrypted-value');
    });

    test('a secret outside the agent grant is never decrypted', async () => {
      agentGrant = { agent: 'default', kortixCli: 'all', connectors: 'all', env: ['PRIMARY'] };

      const response = await brokerRequest();

      expect(response.status).toBe(200);
      expect(
        (brokerCalls[0]?.substitutions as Array<{ identifier: string }>).map((s) => s.identifier),
      ).toEqual(['PRIMARY']);
      expect(decrypted).not.toContain('second-encrypted-value');
    });

    test('a FORGED handle in the request is audited as forged', async () => {
      const real = handleString(SECOND_LOOKUP_ID);
      const forged = `${real.slice(0, -1)}${real.endsWith('a') ? 'b' : 'a'}`;

      const response = await brokerRequest(undefined, {
        body_base64: Buffer.from(JSON.stringify({ key: forged })).toString('base64'),
      });

      expect(response.status).toBe(200);
      const refused = audits.find((event) => event.action === 'secret.handle.refused');
      expect(refused?.outcome).toBe('denied');
      expect(refused?.after).toMatchObject({ refusals: { forged: 1, stolen: 0, host_denied: 0 } });
    });

    test('a VALID handle minted for another session is audited as stolen, not forged', async () => {
      // The tag verifies — this deployment minted it — but the lookup id is not
      // one of THIS session's active handles. Different incident, different
      // reason, and the difference has to survive into the audit row.
      const otherSession = handleString('cccccccccccccccccccc');

      const response = await brokerRequest(undefined, {
        headers: { 'x-carried': otherSession },
      });

      expect(response.status).toBe(200);
      const refused = audits.find((event) => event.action === 'secret.handle.refused');
      expect(refused?.after).toMatchObject({ refusals: { forged: 0, stolen: 1, host_denied: 0 } });
      expect(JSON.stringify(refused?.after)).not.toContain('second-secret-value');
    });

    test('a request carrying only its own admitted handles refuses nothing', async () => {
      const response = await brokerRequest(undefined, {
        headers: { 'x-key': handleString(PRIMARY_LOOKUP_ID) },
      });

      expect(response.status).toBe(200);
      expect(audits.map((event) => event.action)).toEqual([
        'secret.broker.requested',
        'secret.broker.completed',
      ]);
    });

    test('an expired handle is not spendable', async () => {
      handleRows = [handleFor(), secondHandle({ expiresAt: new Date(Date.now() - 60_000) })];

      await brokerRequest();

      expect(
        (brokerCalls[0]?.substitutions as Array<{ identifier: string }>).map((s) => s.identifier),
      ).toEqual(['PRIMARY']);
    });
  });

  test('records broker failures without recording the secret', async () => {
    brokerFailure = new MockSecretBrokerError(
      'upstream_timeout',
      'upstream request timed out',
      504,
    );

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
