/**
 * A bearer token's SCOPE must survive the App bearer-auth path.
 *
 * The hole this pins: the App subdomain's bearer path validated a PAT and then
 * reduced it to a bare `userId`. `appAccessibleToUser` and its `projectManager`
 * fallback therefore called IAM `authorize()` with NO acting token id, and
 * token scope is only evaluated when that id is supplied. A PAT bound to
 * project A opened non-public Apps hosted from project B, because the decision
 * only ever saw the human behind the token, never the token's own limits.
 *
 * The chain under test is real end to end — `authorizeAppRequest` calls the
 * real `appAccessibleToUser`, which calls `authorize`. Only the three leaves
 * are stubbed: token validation, the IAM verdict, and subject resolution, none
 * of which can run without a database. The stubbed `authorize` mirrors the
 * deployed rule in `iam/engine-v2.ts` `computeTokenScope`: a project-bound
 * token may act only on its bound project.
 */
import { describe, expect, mock, test } from 'bun:test';
import * as realCrypto from '../shared/crypto';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.kortix.com';
process.env.KORTIX_APPS_ALLOW_LOCAL_EDGE = 'true';

const USER = 'user-1';
const ACCOUNT = 'acct-1';
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

/** A PAT bound to project A. */
const PAT_SCOPED_A = 'kortix_pat_scoped_a';
/** The SAME user's unscoped laptop PAT. */
const PAT_UNSCOPED = 'kortix_pat_unscoped';

const TOKENS: Record<string, { tokenId: string; projectId: string | null }> = {
  [PAT_SCOPED_A]: { tokenId: 'tok-scoped-a', projectId: PROJECT_A },
  [PAT_UNSCOPED]: { tokenId: 'tok-unscoped', projectId: null },
};
/** tokenId → its project binding, the `account_tokens` row the engine loads. */
const BINDING_BY_TOKEN_ID = new Map(
  Object.values(TOKENS).map((t) => [t.tokenId, t.projectId] as const),
);

mock.module('../shared/crypto', () => ({
  // Spread the real module: mock.module replaces it WHOLESALE, and the auth
  // middleware now reaches shared/crypto through oauth/token-hash too.
  ...realCrypto,
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (t: string) => {
    const known = TOKENS[t];
    if (!known) return { isValid: false, error: 'Invalid PAT' };
    return {
      isValid: true,
      userId: USER,
      accountId: ACCOUNT,
      projectId: known.projectId,
      tokenId: known.tokenId,
    };
  },
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false, error: 'Invalid service account' }),
}));

/** Every `authorize` call the chain made, in order. */
const authorizeCalls: {
  action: string;
  targetProjectId: string | undefined;
  actingTokenId: string | undefined;
}[] = [];

// The credential is part of the Actor now (canonical engine): the acting token
// id no longer travels as a trailing positional argument to `authorize`, it is
// `actor.credential.tokenId`. `actorForToken` normally reads the token binding
// from the DB; this suite has none, so it is stubbed from the same TOKENS table.
mock.module('../iam/actor', () => ({
  actorForUser: (userId: string, accountId: string) => ({
    userId,
    accountId,
    credential: { kind: 'jwt' },
    ctx: {},
  }),
  actorForToken: async (userId: string, accountId: string, tokenId?: string | null) => ({
    userId,
    accountId,
    credential: tokenId
      ? { kind: 'pat', tokenId, projectId: BINDING_BY_TOKEN_ID.get(tokenId) ?? null }
      : { kind: 'jwt' },
    ctx: {},
  }),
}));

mock.module('../iam', () => ({
  PROJECT_ACTIONS: {
    PROJECT_READ: 'project.read',
    PROJECT_MEMBERS_MANAGE: 'project.members.manage',
  },
  authorize: async (
    actor: { credential: { kind: string; tokenId?: string } },
    action: string,
    target?: { type: string; id: string },
  ) => {
    const actingTokenId = actor.credential.kind === 'jwt' ? undefined : actor.credential.tokenId;
    authorizeCalls.push({
      action,
      targetProjectId: target?.id,
      actingTokenId,
    });
    // The user is a full member of BOTH projects. Only token scope can
    // separate them — which is precisely the property that was being skipped.
    if (!actingTokenId) return { allowed: true, reason: 'member' };
    const boundProjectId = BINDING_BY_TOKEN_ID.get(actingTokenId);
    if (boundProjectId === undefined) return { allowed: false, reason: 'token_revoked' };
    if (boundProjectId === null) return { allowed: true, reason: 'member' }; // unscoped PAT
    if (target?.type !== 'project') return { allowed: false, reason: 'out_of_token_scope' };
    return target.id === boundProjectId
      ? { allowed: true, reason: 'member' }
      : { allowed: false, reason: 'out_of_token_scope' };
  },
}));

mock.module('../connectors/share', () => ({
  resolveShareSubject: async (userId: string) => ({ userId, groupIds: [] }),
}));

const { authorizeAppRequest } = await import('./public-proxy');
const { appAccessibleToUser } = await import('./access');

const appInProject = (projectId: string) => ({
  appId: '11111111-1111-4111-8111-111111111111',
  accountId: ACCOUNT,
  projectId,
  name: 'Scoped App',
  // `project` mode: every project member may open it. So the ONLY thing that
  // can deny a member here is the token's own scope.
  accessMode: 'project',
  accessPasswordHash: null,
  accessRevision: 1,
  createdBy: 'someone-else',
  updatedAt: new Date('2026-08-18T00:00:00.000Z'),
});

const openApp = (projectId: string, token: string) => {
  const url = new URL('https://dev-scoped-cccccccccccccccc.apps.kortix.com/api/things');
  return authorizeAppRequest(
    new Request(url, { headers: { authorization: `Bearer ${token}` } }),
    url,
    appInProject(projectId),
  );
};

describe('App bearer auth carries the token, not just the user', () => {
  test('a project-A-scoped PAT cannot open an App hosted from project B', async () => {
    authorizeCalls.length = 0;
    const denied = await openApp(PROJECT_B, PAT_SCOPED_A);
    expect(denied?.status).toBe(401);
    expect(await denied?.json()).toMatchObject({ code: 'app_auth_required' });

    // Prove WHY it was denied: the token id reached authorize, and the verdict
    // turned on the project it was bound to. Without the fix this call carries
    // `actingTokenId: undefined` and the request is allowed.
    expect(authorizeCalls).toEqual([
      { action: 'project.read', targetProjectId: PROJECT_B, actingTokenId: 'tok-scoped-a' },
    ]);
  });

  test('the same PAT still opens the App in the project it is bound to', async () => {
    authorizeCalls.length = 0;
    expect(await openApp(PROJECT_A, PAT_SCOPED_A)).toBeNull();
    expect(authorizeCalls).toEqual([
      { action: 'project.read', targetProjectId: PROJECT_A, actingTokenId: 'tok-scoped-a' },
    ]);
  });

  test('the same user’s UNSCOPED PAT opens the App in either project', async () => {
    authorizeCalls.length = 0;
    expect(await openApp(PROJECT_A, PAT_UNSCOPED)).toBeNull();
    expect(await openApp(PROJECT_B, PAT_UNSCOPED)).toBeNull();
    expect(authorizeCalls.map((c) => c.actingTokenId)).toEqual(['tok-unscoped', 'tok-unscoped']);
  });

  test('the projectManager fallback forwards the acting token id too', async () => {
    // The second authorize call. Reaching it needs PROJECT_READ to PASS and
    // the access decision to fail — a `private` App owned by someone else, in
    // the project this token is bound to.
    authorizeCalls.length = 0;
    expect(
      await appAccessibleToUser(
        { ...appInProject(PROJECT_A), accessMode: 'private' },
        USER,
        'tok-scoped-a',
      ),
    ).toBe(true);
    expect(authorizeCalls).toEqual([
      { action: 'project.read', targetProjectId: PROJECT_A, actingTokenId: 'tok-scoped-a' },
      {
        action: 'project.members.manage',
        targetProjectId: PROJECT_A,
        actingTokenId: 'tok-scoped-a',
      },
    ]);
  });

  test('a browser/JWT caller supplies no token id and keeps its permissions', async () => {
    // The parameter is optional on purpose: the cookie path has no bearer
    // token, and passing undefined must leave the pre-existing decision alone.
    authorizeCalls.length = 0;
    expect(await appAccessibleToUser(appInProject(PROJECT_B), USER)).toBe(true);
    expect(authorizeCalls).toEqual([
      { action: 'project.read', targetProjectId: PROJECT_B, actingTokenId: undefined },
    ]);
  });
});
