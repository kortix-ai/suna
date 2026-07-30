// The ACP prompt route's deadline observation — the ONLY control-plane
// observation an ACP session's box ever gets, since this route deliberately does
// not go through the sandbox proxy.
//
// ═══ THE DEFECT THIS PINS ═══ the gate was written as
//   isSandboxAuthored(c.get('apiKeyType'), c.get('sessionId'))
// and this route is mounted under `supabaseAuth`, which sets `sessionId` to the
// SUPABASE AUTH SESSION id — "which browser login is this" — for every human.
// `isSandboxAuthored` reads any non-null session id as "the box authored this",
// so the observation and the at-cap refusal were DEAD CODE for every browser
// user: an ACP box was never extended by its own prompts and was handed work at
// the 24-hour cap that the reaper then killed mid-turn. `callerKortixSessionId`
// is the repo's existing guard for exactly this collision.
//
// `mock.module` is process-global in bun, so this lives in its own file.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// A Supabase auth session id. Shaped like a uuid, and NOT a Kortix session.
const SUPABASE_AUTH_SESSION_ID = '99999999-8888-4777-8666-555555555555';

let authType: string | undefined;
let contextSessionId: string | undefined;
let apiKeyType: string | undefined;
let observedTargets: unknown[] = [];
let observation: 'granted' | 'at_cap' | 'no_box' = 'granted';
let upstreamFetchCount = 0;

mock.module('../lib/access', () => ({
  assertProjectCapability: async () => {},
  loadProjectForUser: async () => ({
    userId: 'user-1',
    row: { projectId: PROJECT_ID, accountId: 'account-1' },
  }),
  loadVisibleSession: async () => ({
    row: {
      sessionId: SESSION_ID,
      metadata: {
        runtime_transport: 'acp',
        runtime_harness: 'codex',
        acp_server_id: SESSION_ID,
      },
    },
    canManageSharing: true,
  }),
}));

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === sessionSandboxes ? [{ externalId: 'sandbox-external-1' }] : [],
        }),
      }),
    }),
  },
}));

mock.module('../runtime-inspection', () => ({
  sandboxRuntimeEndpoint: async () => ({
    url: 'https://sandbox.test',
    headers: {},
    providerHeaders: {},
    serviceKey: 'service-key',
  }),
}));

mock.module('../../sandbox-proxy/backend', () => ({ invalidateSandbox: () => {} }));
mock.module('../lib/sandbox-env-sync', () => ({ syncSandboxEnvForPrompt: async () => {} }));
mock.module('../lib/acp-transcript', () => ({
  appendAcpEnvelope: async () => ({ ordinal: 1, envelope: {} }),
  loadAcpTranscript: async () => [],
}));
mock.module('../lib/acp-sse-proxy', () => ({ createPersistedAcpSseProxy: (b: unknown) => b }));
// Spread the real module: a PARTIAL module mock makes every un-listed export
// vanish and kills the whole file with a SyntaxError (see #5863).
const realTitle = await import('../session-title-generate');
mock.module('../session-title-generate', () => ({
  ...realTitle,
  generateSessionTitleFromFirstPrompt: async () => {},
}));

// The classifier stays REAL — it is half of what is under test. Only the DB write
// is replaced, so the route's decision to call it at all is observable.
const realDeadline = await import('../sandbox-deadline');
mock.module('../sandbox-deadline', () => ({
  ...realDeadline,
  observeTurnStart: async (target: unknown) => {
    observedTargets.push(target);
    return observation;
  },
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (_input, init) => {
  upstreamFetchCount += 1;
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return Response.json({ jsonrpc: '2.0', id: request.id, result: {} });
}) as typeof fetch;

const { projectsApp } = await import('../lib/app');
// Registered BEFORE the route so it actually wraps it (Hono composes in
// registration order). This stands in for `supabaseAuth` / a PAT auth.
projectsApp.use('/*', async (c, next) => {
  if (authType) c.set('authType', authType as never);
  if (contextSessionId) c.set('sessionId', contextSessionId);
  if (apiKeyType) c.set('apiKeyType', apiKeyType as never);
  await next();
});
await import('./acp');

function prompt() {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-prompt',
      method: 'session/prompt',
      params: { sessionId: 'native-session', prompt: [] },
    }),
  });
}

beforeEach(() => {
  authType = undefined;
  contextSessionId = undefined;
  apiKeyType = undefined;
  observedTargets = [];
  observation = 'granted';
  upstreamFetchCount = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

test('REGRESSION: a BROWSER prompt observes the turn start, despite carrying a Supabase session id', async () => {
  authType = 'supabase';
  contextSessionId = SUPABASE_AUTH_SESSION_ID;

  const response = await prompt();

  expect(response.status).toBe(200);
  expect(observedTargets).toEqual([{ sessionId: SESSION_ID }]);
});

test('REGRESSION: at the 24h cap a browser prompt is REFUSED, not accepted and killed', async () => {
  authType = 'supabase';
  contextSessionId = SUPABASE_AUTH_SESSION_ID;
  observation = 'at_cap';

  const response = await prompt();

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'This sandbox has reached its 24-hour continuous run limit and is restarting.',
    code: 'sandbox_run_cap_reached',
    retry: true,
  });
  // The refusal never reaches the box.
  expect(upstreamFetchCount).toBe(0);
});

test("the SANDBOX's own session-scoped credential never extends its box", async () => {
  // A session-scoped kortix_pat_: authType 'pat', sessionId = the project session.
  // Its auth branch never sets apiKeyType, which is why provenance must be decided
  // by the credential and not by apiKeyType alone.
  authType = 'pat';
  contextSessionId = SESSION_ID;

  const response = await prompt();

  expect(response.status).toBe(200);
  expect(observedTargets).toEqual([]);
});

test('the sandbox API-key type also never extends its box', async () => {
  apiKeyType = 'sandbox';

  const response = await prompt();

  expect(response.status).toBe(200);
  expect(observedTargets).toEqual([]);
});

test('a non-prompt ACP method is not a turn start', async () => {
  authType = 'supabase';
  contextSessionId = SUPABASE_AUTH_SESSION_ID;

  const response = await projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'rpc-1', method: 'initialize', params: {} }),
  });

  expect(response.status).toBe(200);
  expect(observedTargets).toEqual([]);
});
