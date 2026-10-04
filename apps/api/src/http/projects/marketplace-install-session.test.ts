import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../types/app-env';

// Keep the catalog hermetic — the in-repo Kortix source needs no network.
process.env.KORTIX_DEFAULT_MARKETPLACES = '';

// KRTX-1540: an install on an account that cannot serve any model used to
// create the session anyway and let its first turn die with the platform
// default model's internal id ("deepseek-v4.1-flash" requires a paid plan).
// These tests pin the route's gate: the import turn's model must be servable
// BEFORE a session exists, and the refusal must name the plan gate.

const accountId = '10000000-0000-4000-8000-000000000000';
const projectId = '11111111-1111-4111-8111-111111111111';
const userId = '44444444-4444-4444-4444-444444444444';

/** The billing entitlement `accountMayUseManagedModels` answers for the account. */
let managedModels = false;
/** `getCachedAccountTier` — free vs a paid tier that does not include managed models. */
let accountTier = 'free';
/** What the session-default resolution returns: null = only the (unservable) platform default applies. */
let resolvedDefault: string | null = null;
/** The project's `llm_gateway` flag — off, the plan gate does not exist (native mode). */
let gatewayOn = true;
let createSessionCalls = 0;

const app = new OpenAPIHono<AppEnv>();
mock.module('./app', () => ({ projectsApp: app }));
mock.module('../lib/project-access', () => ({
  loadProjectForUser: async () => ({
    userId,
    row: {
      accountId,
      projectId,
      metadata: {},
      repoUrl: 'https://example.test/repo',
      defaultBranch: null,
      manifestPath: null,
    },
  }),
}));
// requireFeatureFlag moved to http/lib/feature-flag-gate.
mock.module('../lib/feature-flag-gate', () => ({ requireFeatureFlag: () => null }));
const realEntitlements = await import('../../services/billing/services/entitlements');
mock.module('../../services/billing/services/entitlements', () => ({
  ...realEntitlements,
  accountMayUseManagedModels: async () => managedModels,
  getCachedAccountTier: async () => accountTier,
}));
const realDefaultModel = await import('../../services/llm-gateway/resolution/default-model');
mock.module('../../services/llm-gateway/resolution/default-model', () => ({
  ...realDefaultModel,
  resolveEffectiveModel: async () => ({
    model: resolvedDefault,
    source: resolvedDefault ? ('account' as const) : ('platform' as const),
  }),
}));
mock.module('../../services/llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: () => gatewayOn,
}));
mock.module('../../services/sessions/lifecycle', () => ({
  createSession: async () => {
    createSessionCalls += 1;
    return {
      status: 'created' as const,
      row: { sessionId: '33333333-3333-4333-8333-333333333333' },
    };
  },
}));
const realGit = await import('../../services/git/project-git');
mock.module('../../services/git/project-git', () => ({
  ...realGit,
  loadGitProject: async () => ({ row: {}, manifestPath: null }),
}));

(await import('./marketplace-install-session')).registerMarketplaceInstallSessionRoutes();

const post = () =>
  app.request(`/${projectId}/marketplace/install-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'kortix-starter:pdf' }),
  });

/** The failure must name the plan gate, never an internal model id. */
const INTERNAL_MODEL_REF = /deepseek|glm-|kimi-|kortix\//;

beforeEach(() => {
  managedModels = false;
  accountTier = 'free';
  resolvedDefault = null;
  gatewayOn = true;
  createSessionCalls = 0;
});

describe('marketplace install-session — the import turn model gate (KRTX-1540)', () => {
  test('an account that cannot serve any model is refused with the plan gate before a session exists', async () => {
    const res = await post();
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('paid plan');
    expect(body.error).not.toMatch(INTERNAL_MODEL_REF);
    expect(body.code).toBe('no_servable_model');
    expect(createSessionCalls).toBe(0);
  });

  test('a paid plan without managed models is refused with the bring-your-own-key remedy', async () => {
    accountTier = 'pro';
    const res = await post();
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain('provider key');
    expect(body.error).not.toContain('paid plan');
    expect(body.error).not.toMatch(INTERNAL_MODEL_REF);
    expect(createSessionCalls).toBe(0);
  });

  test('an account that may use managed models installs as before', async () => {
    managedModels = true;
    const res = await post();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session_id: string };
    expect(body.session_id).toBeTruthy();
    expect(createSessionCalls).toBe(1);
  });

  test('a servable configured default (the account own key) installs without the gate', async () => {
    resolvedDefault = 'anthropic/claude-opus-4.8';
    const res = await post();
    expect(res.status).toBe(201);
    expect(createSessionCalls).toBe(1);
  });

  test('a native (gateway-off) project has no plan gate', async () => {
    gatewayOn = false;
    const res = await post();
    expect(res.status).toBe(201);
    expect(createSessionCalls).toBe(1);
  });
});
