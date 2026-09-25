import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { PROJECT_ACTIONS } from '../iam/actions';
import * as realAccess from '../projects/lib/access';
import * as realReach from '../projects/lib/session-secret-reach';

// POST /v1/projects/:projectId/secret-requests — when a session mints a runtime
// link for a name its own agent cannot receive, the mint response says so. The
// human fills the form either way; without this the agent learns nothing until
// it looks for an env var that never arrives.

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

mock.module('../iam', () => ({ PROJECT_ACTIONS }));
// If anything in the import graph reaches `routes/projects.ts`, it attaches
// `supabaseAuth` to every project route. Pass through; `buildApp` sets the
// caller context the real middleware would.
const realAuth = await import('../middleware/auth');
mock.module('../middleware/auth', () => ({
  ...realAuth,
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next(),
}));
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, name: 'demo' },
    userId: USER_ID,
  }),
  assertProjectCapability: async () => {},
}));

let grantEnv: string[] | 'all' = 'all';
const lookups: Array<{ sessionId: string; names: string[] }> = [];
mock.module('../projects/lib/session-secret-reach', () => ({
  ...realReach,
  sessionWithheldSecrets: async (sessionId: string, names: string[]) => {
    lookups.push({ sessionId, names });
    const withheld = realReach.withheldSecrets(names, grantEnv, null);
    return withheld.length > 0 ? { agent: 'analyst', withheld } : null;
  },
}));

const { projectsApp } = await import('../projects/lib/app');
await import('../projects/routes/setup-links');

let sessionId: string | undefined;

function mint(body: Record<string, unknown>) {
  const app = new Hono<{ Variables: { userId: string; authType: string; sessionId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    if (sessionId) c.set('sessionId', sessionId);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app.request(`/v1/projects/${PROJECT_ID}/secret-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/projects/:projectId/secret-requests — withheld names', () => {
  beforeEach(() => {
    grantEnv = 'all';
    lookups.length = 0;
    sessionId = SESSION_ID;
  });

  test('a runtime link for a name outside the session agent grant names it and the fix', async () => {
    grantEnv = ['OTHER_KEY'];
    const res = await mint({ names: ['API_KEY', 'OTHER_KEY'], scope: 'runtime' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.names).toEqual(['API_KEY', 'OTHER_KEY']);
    expect(body.agent).toBe('analyst');
    expect(body.withheld).toEqual([{ name: 'API_KEY', reason: 'agent_grant' }]);
    expect(body.withheld_fix).toContain('Customize → Agents → analyst → Secrets');
    expect(lookups).toEqual([{ sessionId: SESSION_ID, names: ['API_KEY', 'OTHER_KEY'] }]);
  });

  test('a granted runtime link carries no withheld fields', async () => {
    const res = await mint({ names: ['API_KEY'], scope: 'runtime' });
    const body = await res.json();
    expect(body.withheld).toBeUndefined();
    expect(body.agent).toBeUndefined();
  });

  test('a connector-scoped link never reaches the sandbox, so it is not judged', async () => {
    grantEnv = [];
    const body = await (await mint({ names: ['API_KEY'] })).json();
    expect(body.scope).toBe('connector');
    expect(body.withheld).toBeUndefined();
    expect(lookups).toEqual([]);
  });

  test('a caller with no session (laptop CLI, dashboard) is not judged', async () => {
    sessionId = undefined;
    grantEnv = [];
    const body = await (await mint({ names: ['API_KEY'], scope: 'runtime' })).json();
    expect(body.withheld).toBeUndefined();
    expect(lookups).toEqual([]);
  });
});
