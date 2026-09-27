/**
 * The App gate judges an agent-session credential as the AGENT (spec
 * docs/specs/2026-09-22-agents-as-principals.md §2.5) — through `Authorization`,
 * through `X-Kortix-App-Authorization`, and through the connector's signed
 * assertion — and only when the project's `agent_principal` flag is on.
 *
 * The chain is real: `authorizeAppRequest` → the real
 * `appAccessibleToAgentSession` → `authorize`. Stubbed leaves: token
 * validation (no DB) and the IAM verdict for `project.app.read`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realCrypto from '../shared/crypto';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';
process.env.KORTIX_APPS_ALLOW_LOCAL_EDGE = 'true';

const ACCOUNT = '99999999-9999-4999-8999-999999999999';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const HUMAN = '33333333-3333-4333-8333-333333333333';
const SLUG = 'dashboards';

type Tok = {
  tokenId: string;
  projectId: string | null;
  sessionId: string | null;
  agentGrant: Record<string, unknown> | null;
};
const grant = (agent: string, apps?: string[] | 'all') => ({
  agent,
  permissions: ['project.app.read'],
  connectors: [],
  ...(apps !== undefined ? { apps } : {}),
});
const TOKENS: Record<string, Tok> = {
  kortix_pat_reporter: { tokenId: 'a0000000-0000-4000-8000-000000000001', projectId: PROJECT, sessionId: 'sess-r', agentGrant: grant('reporter', [SLUG]) },
  kortix_pat_bystander: { tokenId: 'a0000000-0000-4000-8000-000000000002', projectId: PROJECT, sessionId: 'sess-b', agentGrant: grant('bystander') },
  kortix_pat_other_project: { tokenId: 'a0000000-0000-4000-8000-000000000003', projectId: OTHER_PROJECT, sessionId: 'sess-o', agentGrant: grant('reporter', 'all') },
  kortix_pat_laptop: { tokenId: 'a0000000-0000-4000-8000-000000000004', projectId: null, sessionId: null, agentGrant: null },
};
const BY_ID = new Map(Object.values(TOKENS).map((t) => [t.tokenId, t]));
const asResult = (t: Tok | undefined) =>
  t ? { isValid: true, userId: HUMAN, accountId: ACCOUNT, ...t } : { isValid: false, error: 'Invalid PAT' };

mock.module('../shared/crypto', () => ({
  ...realCrypto,
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));
mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (t: string) => asResult(TOKENS[t]),
  validateAccountTokenById: async (id: string) => asResult(BY_ID.get(id)),
}));
mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false, error: 'Invalid service account' }),
}));

/** Every `authorize` call, and the verdict it returns for `project.app.read`. */
const authorizeCalls: Array<{ action: string; project?: string; tokenId?: string; sessionId?: string | null }> = [];
let appReadAllowed = true;
mock.module('../iam/actor', () => ({
  actorForUser: (userId: string, accountId: string) => ({ userId, accountId, credential: { kind: 'jwt' }, ctx: {} }),
  actorForToken: async (userId: string, accountId: string, tokenId?: string | null, opts: { sessionId?: string | null } = {}) => ({
    userId,
    accountId,
    credential: tokenId ? { kind: 'pat', tokenId, sessionId: opts.sessionId ?? null } : { kind: 'jwt' },
    ctx: {},
  }),
}));
mock.module('../iam', () => ({
  PROJECT_ACTIONS: {
    PROJECT_READ: 'project.read',
    PROJECT_MEMBERS_MANAGE: 'project.members.manage',
    PROJECT_APP_READ: 'project.app.read',
  },
  authorize: async (
    actor: { credential: { tokenId?: string; sessionId?: string | null } },
    action: string,
    target?: { id: string },
  ) => {
    authorizeCalls.push({ action, project: target?.id, tokenId: actor.credential.tokenId, sessionId: actor.credential.sessionId });
    return action === 'project.app.read' && appReadAllowed ? { allowed: true } : { allowed: false, reason: 'denied' };
  },
}));

let minted: string[] = [];
const realViewer = await import('./viewer');
mock.module('./viewer', () => ({
  ...realViewer,
  resolveAppViewerIdentity: async (userId: string) => ({ email: `${userId}@example.test`, groupIds: [] }),
  mintAppViewerToken: async (_app: unknown, userId: string) => {
    minted.push(userId);
    return { accessToken: 'kortix_oat_minted', expiresAt: new Date(Date.now() + 3600_000), scopes: ['project.read'] };
  },
}));

const { authorizeAppRequest, appViewerEndpointResponse } = await import('./public-proxy');
const { createAppAgentAssertion } = await import('./access');

const app = (over: Record<string, unknown> = {}) => ({
  appId: '11111111-1111-4111-8111-111111111111',
  accountId: ACCOUNT,
  projectId: PROJECT,
  slug: SLUG,
  name: 'Dashboards',
  accessMode: 'restricted',
  accessPasswordHash: null,
  accessRevision: 1,
  createdBy: HUMAN,
  updatedAt: new Date('2026-09-22T00:00:00.000Z'),
  agentPrincipal: true,
  ...over,
});
const URL_ = 'https://dev-dashboards-cccccccccccccccc.apps.kortix.com/api/things';

/** Records whether the legacy human verifier ran; answers `humanAllowed`. */
let humanCalls: Array<{ userId: string; tokenId?: string }> = [];
let humanAllowed = false;
const humanVerifier = async (_app: unknown, userId: string, tokenId?: string) => {
  humanCalls.push({ userId, tokenId });
  return humanAllowed;
};

const open = (headers: Record<string, string>, over: Record<string, unknown> = {}) =>
  authorizeAppRequest(new Request(URL_, { headers }), new URL(URL_), app(over), humanVerifier);

async function expectRefused(res: Response | null) {
  expect(res?.status).toBe(401);
  expect(await res?.json()).toMatchObject({ code: 'app_auth_required' });
}

beforeEach(() => {
  authorizeCalls.length = 0;
  humanCalls = [];
  humanAllowed = false;
  appReadAllowed = true;
});

describe('flag ON — restricted App', () => {
  test('a listed agent passes through Authorization and through X-Kortix-App-Authorization', async () => {
    expect(await open({ authorization: 'Bearer kortix_pat_reporter' })).toBeNull();
    expect(await open({ 'x-kortix-app-authorization': 'Bearer kortix_pat_reporter' })).toBeNull();
    // The App keeps its own key in Authorization while the agent rides in the X header.
    expect(await open({ authorization: 'Bearer app-own-key', 'x-kortix-app-authorization': 'Bearer kortix_pat_reporter' })).toBeNull();
    // Judged as the agent: the human verifier never ran; project.app.read was asked with the session token.
    expect(humanCalls).toEqual([]);
    expect(authorizeCalls[0]).toEqual({
      action: 'project.app.read',
      project: PROJECT,
      tokenId: TOKENS.kortix_pat_reporter!.tokenId,
      sessionId: 'sess-r',
    });
  });

  test('an unlisted agent → 401 app_auth_required through either header, even when its human could open the App', async () => {
    humanAllowed = true;
    await expectRefused(await open({ authorization: 'Bearer kortix_pat_bystander' }));
    await expectRefused(await open({ 'x-kortix-app-authorization': 'Bearer kortix_pat_bystander' }));
    expect(humanCalls).toEqual([]);
  });

  test('a listed agent without project.app.read → 401', async () => {
    appReadAllowed = false;
    await expectRefused(await open({ authorization: 'Bearer kortix_pat_reporter' }));
  });

  test('an agent session of ANOTHER project never opens this App, even with apps: all', async () => {
    await expectRefused(await open({ authorization: 'Bearer kortix_pat_other_project' }));
    expect(authorizeCalls).toEqual([]);
  });

  test('private mode follows the same rule as restricted', async () => {
    expect(await open({ authorization: 'Bearer kortix_pat_reporter' }, { accessMode: 'private' })).toBeNull();
    await expectRefused(await open({ authorization: 'Bearer kortix_pat_bystander' }, { accessMode: 'private' }));
  });
});

describe('flag ON — other modes', () => {
  test('project mode needs project.app.read only', async () => {
    expect(await open({ authorization: 'Bearer kortix_pat_bystander' }, { accessMode: 'project' })).toBeNull();
    appReadAllowed = false;
    await expectRefused(await open({ authorization: 'Bearer kortix_pat_bystander' }, { accessMode: 'project' }));
  });

  test('password mode never admits an agent', async () => {
    await expectRefused(
      await open({ authorization: 'Bearer kortix_pat_reporter' }, { accessMode: 'password', accessPasswordHash: 'x' }),
    );
  });

  test('a laptop PAT (no session) keeps the human decision', async () => {
    humanAllowed = true;
    expect(await open({ authorization: 'Bearer kortix_pat_laptop' })).toBeNull();
    expect(humanCalls).toEqual([{ userId: HUMAN, tokenId: TOKENS.kortix_pat_laptop!.tokenId }]);
  });
});

describe('flag OFF — today’s model byte for byte', () => {
  test('an agent session is judged by the human verifier with its token, apps is ignored', async () => {
    humanAllowed = false;
    await expectRefused(await open({ authorization: 'Bearer kortix_pat_reporter' }, { agentPrincipal: false }));
    humanAllowed = true;
    expect(await open({ authorization: 'Bearer kortix_pat_bystander' }, { agentPrincipal: false })).toBeNull();
    expect(humanCalls).toEqual([
      { userId: HUMAN, tokenId: TOKENS.kortix_pat_reporter!.tokenId },
      { userId: HUMAN, tokenId: TOKENS.kortix_pat_bystander!.tokenId },
    ]);
  });
});

describe('flag OFF — X-Kortix-App-Authorization is ignored', () => {
  test('a plain bearer there is not read; the human verifier is never asked', async () => {
    humanAllowed = true;
    await expectRefused(await open({ 'x-kortix-app-authorization': 'Bearer kortix_pat_reporter' }, { agentPrincipal: false }));
    expect(humanCalls).toEqual([]);
  });

  test('a valid assertion is ignored → today’s 401', async () => {
    humanAllowed = true;
    const assertion = createAppAgentAssertion({ appId: app().appId, projectId: PROJECT, tokenId: TOKENS.kortix_pat_reporter!.tokenId });
    await expectRefused(await open({ 'x-kortix-app-authorization': `Bearer ${assertion}` }, { agentPrincipal: false }));
    expect(humanCalls).toEqual([]);
  });
});

describe('connector → App assertion in X-Kortix-App-Authorization', () => {
  const assertion = (tokenId: string, over: { appId?: string; projectId?: string } = {}) =>
    createAppAgentAssertion({
      appId: over.appId ?? app().appId,
      projectId: over.projectId ?? PROJECT,
      tokenId,
    });

  test('resolves to the session token and gets the §2.5 decision', async () => {
    expect(await open({
      authorization: 'Bearer app-own-key',
      'x-kortix-app-authorization': `Bearer ${assertion(TOKENS.kortix_pat_reporter!.tokenId)}`,
    })).toBeNull();
    await expectRefused(await open({
      'x-kortix-app-authorization': `Bearer ${assertion(TOKENS.kortix_pat_bystander!.tokenId)}`,
    }));
  });

  test('is refused in Authorization (it exists only for the gate header)', async () => {
    await expectRefused(await open({ authorization: `Bearer ${assertion(TOKENS.kortix_pat_reporter!.tokenId)}` }));
  });

  test('is refused for another App or another project', async () => {
    await expectRefused(await open({
      'x-kortix-app-authorization': `Bearer ${assertion(TOKENS.kortix_pat_reporter!.tokenId, { appId: '66666666-6666-4666-8666-666666666666' })}`,
    }));
    await expectRefused(await open({
      'x-kortix-app-authorization': `Bearer ${assertion(TOKENS.kortix_pat_reporter!.tokenId, { projectId: OTHER_PROJECT })}`,
    }));
  });

  test('is refused when it names a token that is not a session token of this project', async () => {
    humanAllowed = true;
    await expectRefused(await open({
      'x-kortix-app-authorization': `Bearer ${assertion(TOKENS.kortix_pat_laptop!.tokenId)}`,
    }));
    await expectRefused(await open({
      'x-kortix-app-authorization': `Bearer ${assertion('a0000000-0000-4000-8000-00000000dead')}`,
    }));
  });
});

describe('/_kortix/viewer for an agent session', () => {
  const viewerUrl = 'https://dev-dashboards-cccccccccccccccc.apps.kortix.com/_kortix/viewer';
  test('flag ON: identity is returned but no api token is minted for the launching human', async () => {
    minted = [];
    const res = await appViewerEndpointResponse(
      new Request(viewerUrl, { headers: { 'x-kortix-app-authorization': 'Bearer kortix_pat_reporter' } }),
      new URL(viewerUrl),
      { ...app(), viewerTokenScope: 'api' },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ user_id: HUMAN, access_token: null, scopes: [] });
    expect(minted).toEqual([]);
  });

  test('flag ON: an unlisted agent gets no viewer identity', async () => {
    const res = await appViewerEndpointResponse(
      new Request(viewerUrl, { headers: { authorization: 'Bearer kortix_pat_bystander' } }),
      new URL(viewerUrl),
      { ...app(), viewerTokenScope: 'api' },
    );
    expect(res.status).toBe(401);
  });
});
