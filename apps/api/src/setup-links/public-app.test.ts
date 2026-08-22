import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { connectors, projectSessions, projects } from '@kortix/db';

mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-pepper' } }));

const realSecrets = await import('../projects/secrets');
const writes: Array<Record<string, unknown>> = [];
mock.module('../projects/secrets', () => ({
  ...realSecrets,
  writeSharedProjectSecret: async (input: Record<string, unknown>) => {
    writes.push(input);
  },
}));

let sessionRows: Array<Record<string, unknown>> = [];
let projectRows: Array<Record<string, unknown>> = [];
let connectorRows: Array<Record<string, unknown>> = [];
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === projectSessions
              ? sessionRows
              : table === projects
                ? projectRows
                : table === connectors
                  ? connectorRows
                  : [],
        }),
      }),
    }),
  },
}));

mock.module('../shared/rate-limit', () => ({
  TokenBucketRateLimiter: class {},
  enforceRateLimit: async () => null,
  createProjectSecretWriteRateLimitMiddleware: () => async (_c: any, next: any) => next(),
  consumeProjectSessionCreateBudget: () => ({ allowed: true, limit: 100, remaining: 99, resetMs: 1000 }),
}));

const propagated: string[] = [];
mock.module('../projects/lib/sandbox-env-sync', () => ({
  propagateProjectSecretsToActiveSandboxes: async (projectId: string) => {
    propagated.push(projectId);
  },
}));

const enqueued: Array<Record<string, unknown>> = [];
mock.module('../projects/session-lifecycle', () => ({
  enqueueContinueSessionCommand: async (input: Record<string, unknown>) => {
    enqueued.push(input);
  },
  drainSessionLifecycleQueue: async () => {},
}));

let pipedreamOn = false;
let finalizeResult: { connected: boolean; accountId?: string } = { connected: false };
const finalizeCalls: Array<Record<string, unknown>> = [];
mock.module('../connectors/pipedream', () => ({
  pipedreamConfigured: () => pipedreamOn,
  pipedreamConnectUrl: async () => ({ connectUrl: null }),
  finalizePipedreamConnection: async (opts: Record<string, unknown>) => {
    finalizeCalls.push(opts);
    return finalizeResult;
  },
}));

let credentialAlreadySet = false;
mock.module('../connectors/credentials', () => ({
  credentialExists: async () => credentialAlreadySet,
}));

const { mintSetupLink } = await import('./token');
const { setupLinksPublicApp, secretSubmittedPrompt, connectorConnectedPrompt } = await import(
  './public-app'
);

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONNECTOR_ID = '99999999-8888-7777-6666-555555555555';
const T0 = new Date('2026-08-07T12:00:00.000Z');

function mintToken(opts?: { expiresInMinutes?: number; sid?: string | null }) {
  return mintSetupLink(
    PROJECT_ID,
    {
      kind: 'secret',
      fields: [{ name: 'DRATA_API_KEY' }],
      scope: 'runtime',
      uid: 'user-1',
      sid: opts?.sid === undefined ? SESSION_ID : opts.sid,
    },
    { expiresInMinutes: opts?.expiresInMinutes },
  ).token;
}

async function flushNotification() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function mintConnectorToken(opts?: { sid?: string | null; app?: string | null }) {
  return mintSetupLink(PROJECT_ID, {
    kind: 'connector',
    slug: 'smartlead',
    app: opts?.app === undefined ? 'smartlead' : opts.app,
    uid: 'user-1',
    sid: opts?.sid === undefined ? SESSION_ID : opts.sid,
  }).token;
}

function finalize(token: string) {
  return setupLinksPublicApp.request(`/connectors/${token}/finalize`, { method: 'POST' });
}

beforeEach(() => {
  setSystemTime(T0);
  writes.length = 0;
  propagated.length = 0;
  enqueued.length = 0;
  finalizeCalls.length = 0;
  sessionRows = [];
  projectRows = [{ name: 'Kortix Company' }];
  connectorRows = [
    { connectorId: CONNECTOR_ID, providerType: 'pipedream', authorizationStrategy: 'project' },
  ];
  pipedreamOn = false;
  credentialAlreadySet = false;
  finalizeResult = { connected: false };
});

afterEach(() => {
  setSystemTime();
});

describe('GET /secret/:token', () => {
  test('a live token returns the requested fields and expiry', async () => {
    const res = await setupLinksPublicApp.request(`/secret/${mintToken()}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fields).toEqual([{ name: 'DRATA_API_KEY', label: null, description: null }]);
    expect(body.expires_at).toBe(new Date(T0.getTime() + 7 * 24 * 60 * 60_000).toISOString());
  });

  test('an expired token returns 410 with expiry wording, not a generic 404', async () => {
    const token = mintToken({ expiresInMinutes: 1 });
    setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    const res = await setupLinksPublicApp.request(`/secret/${token}`);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain('expired');
  });

  test('a mangled token returns 404', async () => {
    const res = await setupLinksPublicApp.request(`/secret/${mintToken().slice(0, -8)}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /secret/:token', () => {
  function submit(token: string, values: Record<string, string> = { DRATA_API_KEY: 'v-1' }) {
    return setupLinksPublicApp.request(`/secret/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    });
  }

  test('saves the value, propagates, and notifies the running requesting session', async () => {
    sessionRows = [{ status: 'running', accountId: 'acct-1', metadata: {} }];
    const res = await submit(mintToken());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, saved: ['DRATA_API_KEY'] });
    expect(writes).toHaveLength(1);
    expect(propagated).toEqual([PROJECT_ID]);
    await flushNotification();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      source: 'system:secret-submitted',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      accountId: 'acct-1',
      actorUserId: 'user-1',
    });
    expect(String(enqueued[0].text)).toContain('DRATA_API_KEY');
  });

  test('does not notify a stopped session — submit must never boot a sandbox', async () => {
    sessionRows = [{ status: 'stopped', accountId: 'acct-1', metadata: {} }];
    const res = await submit(mintToken());
    expect(res.status).toBe(200);
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });

  test('does not notify a deleted session', async () => {
    sessionRows = [
      { status: 'running', accountId: 'acct-1', metadata: { deletedAt: '2026-08-01T00:00:00Z' } },
    ];
    await submit(mintToken());
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });

  test('skips notification when the token carries no session', async () => {
    sessionRows = [{ status: 'running', accountId: 'acct-1', metadata: {} }];
    const res = await submit(mintToken({ sid: null }));
    expect(res.status).toBe(200);
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });

  test('an expired token cannot submit and returns 410', async () => {
    const token = mintToken({ expiresInMinutes: 1 });
    setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    const res = await submit(token);
    expect(res.status).toBe(410);
    expect(writes).toHaveLength(0);
  });
});

describe('POST /connectors/:token/finalize', () => {
  test('a secret token is the wrong link type → 400', async () => {
    pipedreamOn = true;
    const res = await finalize(mintToken());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Wrong link type');
    expect(finalizeCalls).toHaveLength(0);
  });

  test('an unknown token → 404', async () => {
    pipedreamOn = true;
    const res = await finalize('ksl_bogus');
    expect(res.status).toBe(404);
    expect(finalizeCalls).toHaveLength(0);
  });

  test('an expired token → 410', async () => {
    pipedreamOn = true;
    const token = mintSetupLink(
      PROJECT_ID,
      { kind: 'connector', slug: 'smartlead', app: 'smartlead', uid: 'user-1', sid: SESSION_ID },
      { expiresInMinutes: 1 },
    ).token;
    setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    const res = await finalize(token);
    expect(res.status).toBe(410);
  });

  test('Pipedream not configured on this deployment → 501', async () => {
    pipedreamOn = false;
    const res = await finalize(mintConnectorToken());
    expect(res.status).toBe(501);
  });

  test('a connector with no Pipedream app bound → 400', async () => {
    pipedreamOn = true;
    const res = await finalize(mintConnectorToken({ app: null }));
    expect(res.status).toBe(400);
  });

  test('a non-pipedream / missing connector → 404', async () => {
    pipedreamOn = true;
    connectorRows = [];
    expect((await finalize(mintConnectorToken())).status).toBe(404);
    connectorRows = [
      { connectorId: CONNECTOR_ID, providerType: 'http', authorizationStrategy: 'project' },
    ];
    expect((await finalize(mintConnectorToken())).status).toBe(404);
  });

  test('a per-user authorization strategy → 409', async () => {
    pipedreamOn = true;
    connectorRows = [
      { connectorId: CONNECTOR_ID, providerType: 'pipedream', authorizationStrategy: 'user' },
    ];
    const res = await finalize(mintConnectorToken());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('CONNECTOR_AUTHORIZATION_STRATEGY_MISMATCH');
  });

  test('already connected → {connected:true}, no finalize, no notification', async () => {
    pipedreamOn = true;
    credentialAlreadySet = true;
    sessionRows = [{ status: 'running', accountId: 'acct-1', metadata: {} }];
    const res = await finalize(mintConnectorToken());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(finalizeCalls).toHaveLength(0);
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });

  test('not connected yet → 200 {connected:false} so the client keeps polling', async () => {
    pipedreamOn = true;
    finalizeResult = { connected: false };
    sessionRows = [{ status: 'running', accountId: 'acct-1', metadata: {} }];
    const res = await finalize(mintConnectorToken());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(finalizeCalls).toHaveLength(1);
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });

  test('connected → persists and notifies the running requesting session', async () => {
    pipedreamOn = true;
    finalizeResult = { connected: true, accountId: 'apn_1' };
    sessionRows = [{ status: 'running', accountId: 'acct-1', metadata: {} }];
    const res = await finalize(mintConnectorToken());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(finalizeCalls[0]).toMatchObject({
      projectId: PROJECT_ID,
      slug: 'smartlead',
      app: 'smartlead',
      connectorId: CONNECTOR_ID,
      userId: null,
    });
    await flushNotification();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      source: 'system:connector-connected',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      accountId: 'acct-1',
      actorUserId: 'user-1',
    });
    expect(String(enqueued[0].text)).toContain('smartlead');
  });

  test('does not notify a stopped session — a public poll must never boot a sandbox', async () => {
    pipedreamOn = true;
    finalizeResult = { connected: true };
    sessionRows = [{ status: 'stopped', accountId: 'acct-1', metadata: {} }];
    expect((await finalize(mintConnectorToken())).status).toBe(200);
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });

  test('does not notify a deleted session', async () => {
    pipedreamOn = true;
    finalizeResult = { connected: true };
    sessionRows = [
      { status: 'running', accountId: 'acct-1', metadata: { deletedAt: '2026-08-01T00:00:00Z' } },
    ];
    await finalize(mintConnectorToken());
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });

  test('a token minted without a session connects but notifies nobody', async () => {
    pipedreamOn = true;
    finalizeResult = { connected: true };
    sessionRows = [{ status: 'running', accountId: 'acct-1', metadata: {} }];
    const res = await finalize(mintConnectorToken({ sid: null }));
    expect(await res.json()).toEqual({ connected: true });
    await flushNotification();
    expect(enqueued).toHaveLength(0);
  });
});

describe('connectorConnectedPrompt', () => {
  test('names the connector, points at the verification command, forbids re-minting', () => {
    const text = connectorConnectedPrompt('smartlead', 'smartlead');
    expect(text).toContain('smartlead');
    expect(text).toContain('kortix connectors ls');
    expect(text).toContain('Do not mint a new connect link');
  });

  test('names both the app and the slug when they differ', () => {
    const text = connectorConnectedPrompt('crm', 'hubspot');
    expect(text).toContain('hubspot');
    expect(text).toContain('crm');
  });
});

describe('secretSubmittedPrompt', () => {
  test('names every saved key and tells the agent not to re-mint', () => {
    const text = secretSubmittedPrompt(['DRATA_API_KEY', 'DRATA_WORKSPACE_ID']);
    expect(text).toContain('DRATA_API_KEY, DRATA_WORKSPACE_ID');
    expect(text).toContain('kortix secrets sync');
    expect(text).toContain('Do not mint a new intake link');
  });
});
