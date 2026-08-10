import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-pepper' } }));

const realSecrets = await import('../workspaces/secrets');
const writes: Array<Record<string, unknown>> = [];
mock.module('../workspaces/secrets', () => ({
  ...realSecrets,
  writeSharedWorkspaceSecret: async (input: Record<string, unknown>) => {
    writes.push(input);
  },
}));

let sessionRows: Array<Record<string, unknown>> = [];
let projectRows: Array<Record<string, unknown>> = [];
mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === projectSessions ? sessionRows : table === projects ? projectRows : [],
        }),
      }),
    }),
  },
}));

mock.module('../shared/rate-limit', () => ({
  TokenBucketRateLimiter: class {},
  enforceRateLimit: async () => null,
}));

const propagated: string[] = [];
mock.module('../workspaces/lib/sandbox-env-sync', () => ({
  propagateWorkspaceSecretsToActiveSandboxes: async (workspaceId: string) => {
    propagated.push(workspaceId);
  },
}));

const enqueued: Array<Record<string, unknown>> = [];
mock.module('../workspaces/session-lifecycle', () => ({
  enqueueContinueSessionCommand: async (input: Record<string, unknown>) => {
    enqueued.push(input);
  },
  drainSessionLifecycleQueue: async () => {},
}));

mock.module('../connectors/pipedream', () => ({
  pipedreamConfigured: () => false,
  pipedreamConnectUrl: async () => ({ connectUrl: null }),
}));

const { mintSetupLink } = await import('./token');
const { setupLinksPublicApp, secretSubmittedPrompt } = await import('./public-app');

const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T0 = new Date('2026-08-07T12:00:00.000Z');

function mintToken(opts?: { expiresInMinutes?: number; sid?: string | null }) {
  return mintSetupLink(
    WORKSPACE_ID,
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

beforeEach(() => {
  setSystemTime(T0);
  writes.length = 0;
  propagated.length = 0;
  enqueued.length = 0;
  sessionRows = [];
  projectRows = [{ name: 'Kortix Company' }];
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
    expect(propagated).toEqual([WORKSPACE_ID]);
    await flushNotification();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      source: 'system:secret-submitted',
      workspaceId: WORKSPACE_ID,
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

describe('secretSubmittedPrompt', () => {
  test('names every saved key and tells the agent not to re-mint', () => {
    const text = secretSubmittedPrompt(['DRATA_API_KEY', 'DRATA_WORKSPACE_ID']);
    expect(text).toContain('DRATA_API_KEY, DRATA_WORKSPACE_ID');
    expect(text).toContain('kortix secrets sync');
    expect(text).toContain('Do not mint a new intake link');
  });
});
