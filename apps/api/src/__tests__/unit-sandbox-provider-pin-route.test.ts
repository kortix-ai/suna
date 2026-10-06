import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { PROJECT_ACTIONS } from '../iam/actions';

// PATCH /v1/projects/:projectId/sandbox-provider — the ONE writer of the
// project-wide sandbox-provider pin (provider-transition activation aside).
// KRTX-1681: a security-audit agent session unblocked its own task by running
// `kortix sandboxes provider daytona` through this route and flipped EVERY new
// session in the project. A project-wide provider pin is a person's decision:
// this suite pins the rule that a session-bound or agent-grant token is
// refused here, whatever its kortix_permissions, while the web UI and a
// human's PAT keep working.

const PROJECT_ID = '55555555-5555-5555-5555-555555555555';
const ACCOUNT_ID = '66666666-6666-6666-6666-666666666666';
const USER_ID = '11111111-1111-4111-8111-111111111111';

// The `../iam` barrel's dependency graph is part of this route's transitive
// graph anyway (connection-mutation, project-resources), so the mock spreads
// the REAL barrel — every importer gets its real exports — and nothing here
// depends on a hand-written stub staying in sync.
const realIam = await import('../iam');
mock.module('../iam', () => ({ ...realIam }));

const transitionCalls: Array<{ projectId: string; targetRaw: unknown }> = [];
const capabilityCalls: string[] = [];

mock.module('../shared/db', () => ({ db: {}, hasDatabase: true }));
const realAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, status: 'active' },
    userId: USER_ID,
    projectRole: 'manager',
    effectiveRole: 'manager',
  }),
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    capabilityCalls.push(action);
  },
}));
// Spread the REAL serializers module and override only serializeProject: the
// barrel's other importers in the route's transitive graph need its remaining
// exports, and a wholesale stub would break them.
const realSerializers = await import('../projects/lib/serializers');
mock.module('../projects/lib/serializers', () => ({
  ...realSerializers,
  serializeProject: () => ({ project_id: PROJECT_ID }),
}));

// Loading routes/projects.ts (via the serializers graph) registers
// `projectsApp.use('/*', supabaseAuth)` — real credential verification, which
// would 401 every request before the route runs. Swap the registered
// middleware for a passthrough: the suite sets the context fields the
// middleware would have derived (authType, sessionId, agentGrant).
const realAuth = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module('../projects/provider-transition/provider-transition-service', () => ({
  requestProviderTransition: async (input: { projectId: string; targetRaw: unknown }) => {
    transitionCalls.push(input);
    return {
      kind: 'immediate' as const,
      pin: input.targetRaw,
      projectRow: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, status: 'active' },
    };
  },
  readPublicProjectTransitionState: async () => ({ latest: null }),
  ProviderTransitionError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

const { projectsApp } = await import('../projects/lib/app');
// R4 explicit routes: the routes register on call, not at import.
(await import('../projects/routes/project-settings')).registerProjectSettingsRoutes();

type Principal = {
  authType: 'supabase' | 'pat' | 'service_account';
  sessionId?: string;
  agentGrant?: Record<string, unknown> | null;
};

function buildApp(principal: Principal) {
  const app = new Hono<{
    Variables: {
      userId: string;
      authType: 'supabase' | 'pat' | 'service_account';
      sessionId?: string;
      agentGrant?: Record<string, unknown> | null;
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', principal.authType);
    if (principal.sessionId) c.set('sessionId', principal.sessionId);
    c.set('agentGrant', principal.agentGrant ?? null);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function patchProvider(principal: Principal, body: Record<string, unknown> = { provider: 'daytona' }) {
  return buildApp(principal).request(`/v1/projects/${PROJECT_ID}/sandbox-provider`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /v1/projects/:projectId/sandbox-provider — agent sessions cannot flip the pin', () => {
  beforeEach(() => {
    transitionCalls.length = 0;
    capabilityCalls.length = 0;
  });

  test('a session-bound token (the CLI inside an agent sandbox) is refused and the pin write never runs', async () => {
    const response = await patchProvider({
      authType: 'pat',
      // What a session token validates as: an account-token row bound to the
      // session (middleware/auth-principal.ts patPrincipal sets sessionId).
      sessionId: 'sess-123',
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'agent_session_forbidden' });
    expect(typeof body.error).toBe('string');
    // The refusal happens BEFORE the pin write: the provider is unchanged.
    expect(transitionCalls).toEqual([]);
  });

  test('a governed agent grant (all permissions) is refused too — no grant unlocks this', async () => {
    const response = await patchProvider({
      authType: 'pat',
      agentGrant: { agent: 'security-factory', permissions: 'all', connectors: [] },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'agent_session_forbidden' });
    expect(transitionCalls).toEqual([]);
  });

  test('the web UI (a Supabase session) still routes the pin write', async () => {
    const response = await patchProvider({ authType: 'supabase' });

    expect(response.status).toBe(200);
    expect(transitionCalls).toEqual([{ projectId: PROJECT_ID, targetRaw: 'daytona' }]);
  });

  test("a human's personal access token (no session binding, no grant) still routes the pin write", async () => {
    const response = await patchProvider({ authType: 'pat' });

    expect(response.status).toBe(200);
    expect(transitionCalls).toHaveLength(1);
  });

  test('a clearing request from an agent session is refused the same way', async () => {
    const response = await patchProvider({ authType: 'pat', sessionId: 'sess-123' }, { provider: null });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'agent_session_forbidden' });
    expect(transitionCalls).toEqual([]);
  });

  test('the capability leaf is still asserted before the write for a human caller', async () => {
    await patchProvider({ authType: 'supabase' });
    expect(capabilityCalls).toEqual([PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE]);
  });
});
