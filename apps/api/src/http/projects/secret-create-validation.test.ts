/**
 * CHARACTERIZATION: the rejected consumer/strategy/egress combinations of
 * POST /:projectId/secrets, with their exact response bodies.
 *
 * The create handler's validation ladder is about to be extracted from
 * secrets.ts into lib/secret-write-input.ts. This table pins the observable
 * contract through the real route so the extraction cannot move a message, a
 * status code or a precedence: every case here returns BEFORE the first DB
 * read in the handler, so the test runs hermetically — no database, no
 * Docker. Cases that need a DB row (value-required on a new secret, the
 * secrets_egress gate, the identifier-key conflict, the boundary destination
 * conflict) are covered by unit-project-secret-strategy-route.test.ts and the
 * REST flows, not here.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';

// The only collaborator a pre-DB rejection can reach. Spread the real module:
// a wholesale stub drops every export another importer in the graph needs.
const realProjectAccess = await import('../lib/project-access');
mock.module('../lib/project-access', () => ({
  ...realProjectAccess,
  loadProjectForUser: async () => ({
    row: {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      metadata: { experimental: { secrets_egress: true } },
    },
    userId: USER_ID,
    effectiveRole: 'owner',
    adminBypass: false,
  }),
  assertProjectCapability: async () => undefined,
}));

const { projectsApp } = await import('./app');
(await import('./secrets')).registerSecretsRoutes();

function buildApp(caller: { agentSession?: boolean }) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', caller.agentSession ? 'pat' : 'supabase');
    if (caller.agentSession) {
      c.set('sessionId', '55555555-5555-4555-8555-555555555555');
      c.set('agentGrant', { agent: 'analyst', permissions: 'all', connectors: 'all', env: 'all' });
    }
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

const HUMAN: { agentSession?: boolean } = {};
const AGENT: { agentSession?: boolean } = { agentSession: true };

type Case = {
  name: string;
  body: Record<string, unknown>;
  caller?: { agentSession?: boolean };
  status: number;
  json: Record<string, unknown>;
};

// Every rejected combination of the consumer/strategy/egress ladder, in the
// order the handler checks it. `name`/`value` are valid in every row except
// the row that tests them, so each expected error is the FIRST one reached.
const CASES: Case[] = [
  {
    name: 'name is required',
    body: { value: 'x' },
    status: 400,
    json: { error: 'name is required' },
  },
  {
    name: 'name must be a valid env var name',
    body: { name: 'not-valid!', value: 'x' },
    status: 400,
    json: { error: 'name must be a valid env var name (A-Z, 0-9, _; max 64 chars)' },
  },
  {
    name: 'KORTIX_* names are reserved',
    body: { name: 'KORTIX_THING', value: 'x' },
    status: 400,
    json: { error: 'KORTIX_* names are reserved for platform/runtime-managed variables' },
  },
  {
    name: 'CODEX_AUTH_JSON is managed by onboarding',
    body: { name: 'CODEX_AUTH_JSON', value: 'x' },
    status: 400,
    json: { error: 'CODEX_AUTH_JSON is managed by ChatGPT subscription onboarding' },
  },
  {
    name: 'identifier must be alphanumeric',
    body: { name: 'VALID_NAME', identifier: 'bad ident!', value: 'x' },
    status: 400,
    json: { error: 'identifier must be alphanumeric (A-Z, 0-9, _, ., -; max 128 chars)' },
  },
  {
    name: 'consumer is invalid',
    body: { name: 'VALID_NAME', value: 'x', consumer: 'wat' },
    status: 400,
    json: { error: 'consumer is invalid' },
  },
  {
    name: 'strategy must be a known delivery',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'wat' },
    status: 400,
    json: { error: 'secret creation supports runtime, broker, egress, or denied delivery' },
  },
  {
    name: 'broker creation without a consumer',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'broker' },
    status: 400,
    json: { error: 'broker creation requires a supported server consumer' },
  },
  {
    name: 'broker creation with the sandbox consumer',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'broker', consumer: 'sandbox' },
    status: 400,
    json: { error: 'broker creation requires a supported server consumer' },
  },
  {
    name: 'runtime creation with a non-sandbox consumer',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'runtime', consumer: 'connector' },
    status: 400,
    json: { error: 'runtime creation requires the sandbox consumer' },
  },
  {
    name: 'egress creation with a non-network consumer',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'egress', consumer: 'sandbox' },
    status: 400,
    json: { error: 'egress creation requires the network consumer' },
  },
  {
    name: 'denied creation with a consumer',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'denied', consumer: 'sandbox' },
    status: 400,
    json: { error: 'denied creation cannot have a consumer' },
  },
  {
    name: 'consumer without a strategy',
    body: { name: 'VALID_NAME', value: 'x', consumer: 'sandbox' },
    status: 400,
    json: { error: 'consumer requires a strategy' },
  },
  {
    name: 'a null consumer without a strategy',
    body: { name: 'VALID_NAME', value: 'x', consumer: null },
    status: 400,
    json: { error: 'consumer requires a strategy' },
  },
  {
    name: 'an agent session cannot set broker/llm_gateway delivery',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'broker', consumer: 'llm_gateway' },
    caller: AGENT,
    status: 403,
    json: { error: 'Agent sessions cannot change secret delivery policy' },
  },
  {
    name: 'an agent session cannot set egress delivery',
    body: { name: 'VALID_NAME', value: 'x', strategy: 'egress', consumer: 'network' },
    caller: AGENT,
    status: 403,
    json: { error: 'Agent sessions cannot change secret delivery policy' },
  },
  {
    name: 'an outbound policy on a plain secret',
    body: {
      name: 'VALID_NAME',
      value: 'x',
      egress_policy: { rules: [{ host: 'api.example.com' }] },
    },
    status: 400,
    json: { error: 'This consumer does not accept an outbound policy' },
  },
  {
    name: 'an unparseable egress policy',
    body: {
      name: 'VALID_NAME',
      value: 'x',
      strategy: 'broker',
      consumer: 'http_broker',
      egress_policy: 'nope',
    },
    status: 400,
    json: { error: 'policy must be an object', code: 'secret_delivery_policy_invalid' },
  },
  {
    name: 'HTTP broker requires the kortix_fetch backend',
    body: {
      name: 'VALID_NAME',
      value: 'x',
      strategy: 'broker',
      consumer: 'http_broker',
      egress_policy: { rules: [{ host: 'api.example.com' }], backend: 'connector' },
    },
    status: 400,
    json: { error: 'HTTP broker requires the kortix_fetch backend' },
  },
  {
    name: 'network boundary requires exact hosts',
    body: {
      name: 'VALID_NAME',
      value: 'x',
      strategy: 'egress',
      consumer: 'network',
      egress_policy: { rules: [{ host: '*.example.com' }] },
    },
    status: 400,
    json: {
      error: 'Network-boundary delivery requires exact hosts',
      code: 'secret_delivery_policy_invalid',
    },
  },
  {
    name: 'handle_prefix over 48 characters',
    body: {
      name: 'VALID_NAME',
      value: 'x',
      strategy: 'broker',
      consumer: 'http_broker',
      egress_policy: { rules: [{ host: 'api.example.com' }], backend: 'kortix_fetch' },
      handle_prefix: 'x'.repeat(49),
    },
    status: 400,
    json: { error: 'handle_prefix must contain at most 48 characters' },
  },
];

describe('POST /:projectId/secrets — rejected consumer/strategy/egress combinations', () => {
  for (const { name, body, caller = HUMAN, status, json } of CASES) {
    test(`${name} → ${status}`, async () => {
      const response = await buildApp(caller).request(`/v1/projects/${PROJECT_ID}/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(json);
    });
  }
});
