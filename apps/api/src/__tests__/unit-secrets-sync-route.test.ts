import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { PROJECT_ACTIONS } from '../iam/actions';
import * as realAccess from '../projects/lib/access';

// POST /v1/projects/:projectId/secrets/sync — who syncs what.
//
// A person re-pushes the whole project (every active sandbox). An agent session
// pulls ITS OWN session only: the same per-session work its every prompt
// already does, so the agent can pick up a just-saved secret or a just-widened
// grant mid-turn without reaching any other session's box (d649d08932, F6).

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

mock.module('../iam', () => ({ PROJECT_ACTIONS }));
const realAuth = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const capabilities: string[] = [];
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, name: 'demo' },
    userId: USER_ID,
    effectiveRole: 'owner',
  }),
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    capabilities.push(action);
  },
}));

const REPORT = {
  ok: true,
  active_sandboxes: 1,
  targeted: 1,
  synced: 1,
  failed: 0,
  exported: 2,
  results: [],
};
const projectWide: string[] = [];
const ownSession: Array<[string, string]> = [];
const realSync = await import('../projects/lib/sandbox-env-sync');
mock.module('../projects/lib/sandbox-env-sync', () => ({
  ...realSync,
  propagateProjectSecretsToActiveSandboxes: async (projectId: string) => {
    projectWide.push(projectId);
    return REPORT;
  },
  syncSessionSecretsToSandbox: async (projectId: string, sessionId: string) => {
    ownSession.push([projectId, sessionId]);
    return REPORT;
  },
}));

const reconciled: string[] = [];
let reconcileThrows = false;
const realGrant = await import('../projects/lib/session-token-grant');
mock.module('../projects/lib/session-token-grant', () => ({
  ...realGrant,
  reconcileStoredSessionAgentGrant: async (input: { sessionId: string }) => {
    reconciled.push(input.sessionId);
    if (reconcileThrows) throw new Error('manifest unreadable');
    return null;
  },
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/secrets');

type Caller = { sessionId?: string; agentGrant?: Record<string, unknown> | null; authType?: string };

function sync(caller: Caller) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', caller.authType ?? 'supabase');
    if (caller.sessionId) c.set('sessionId', caller.sessionId);
    c.set('agentGrant', caller.agentGrant ?? null);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app.request(`/v1/projects/${PROJECT_ID}/secrets/sync`, { method: 'POST' });
}

const AGENT = { agent: 'analyst', permissions: 'all', connectors: 'all', env: ['A_KEY'] };

describe('POST /v1/projects/:projectId/secrets/sync', () => {
  beforeEach(() => {
    capabilities.length = 0;
    projectWide.length = 0;
    ownSession.length = 0;
    reconciled.length = 0;
    reconcileThrows = false;
  });

  test('a person re-pushes the whole project, gated on secret.write', async () => {
    const res = await sync({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(projectWide).toEqual([PROJECT_ID]);
    expect(ownSession).toEqual([]);
    expect(capabilities).toEqual([PROJECT_ACTIONS.PROJECT_SECRET_WRITE]);
  });

  test('an agent session pulls its own session only, after refreshing its grant', async () => {
    const res = await sync({ authType: 'pat', sessionId: SESSION_ID, agentGrant: AGENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(ownSession).toEqual([[PROJECT_ID, SESSION_ID]]);
    expect(projectWide).toEqual([]);
    expect(reconciled).toEqual([SESSION_ID]);
    // Pulling into its own box writes nothing: read is the gate.
    expect(capabilities).toEqual([PROJECT_ACTIONS.PROJECT_SECRET_READ]);
  });

  test('an unreadable grant does not block the pull — env delivery resolves the grant itself', async () => {
    reconcileThrows = true;
    const res = await sync({ authType: 'pat', sessionId: SESSION_ID, agentGrant: AGENT });
    expect(res.status).toBe(200);
    expect(ownSession).toEqual([[PROJECT_ID, SESSION_ID]]);
  });

  test('an agent token bound to no session has no own box and is refused', async () => {
    const res = await sync({ authType: 'pat', agentGrant: AGENT });
    expect(res.status).toBe(403);
    expect(projectWide).toEqual([]);
    expect(ownSession).toEqual([]);
  });
});
