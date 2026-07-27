/**
 * Unit tests for authorizeGitProxy — the git proxy's trust boundary.
 *
 * The proxy is the UNIVERSAL client-facing git origin (`kortix ship`, `kortix
 * projects clone`, the sandbox daemon all reach a repo through it), so its
 * authorization rules decide whether those commands work at all. Token-account
 * equality alone was too strict: a PAT is bound to ONE account, so anyone in
 * two accounts (personal + team) could create a project through the API and
 * then never push to it — while POST /git-token, which hands out a STRONGER
 * credential, accepted them via the per-project capability. These pin the
 * rules: same account passes, a cross-account grant passes ONLY through the
 * IAM leaf, and everything else stays denied.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ACCOUNT = 'acct-owner';
const OTHER_ACCOUNT = 'acct-other';

let projectRow: Record<string, unknown> | null = null;
let patResult: Record<string, unknown> = {};
let apiKeyResult: Record<string, unknown> = {};
let authorizeAllowed = false;
let authorizeCalls: Array<{
  userId: string;
  accountId: string;
  action: string;
  actingTokenId?: string;
}> = [];

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (projectRow ? [projectRow] : []) }),
      }),
    }),
  },
  hasDatabase: true,
}));
// Spread the real modules and override only the seams under test — replacing
// them wholesale would strip exports other importers in this process need.
const realAccountTokens = await import('../repositories/account-tokens');
const realApiKeys = await import('../repositories/api-keys');
const realIamActions = await import('../iam/actions');
const realIamDispatcher = await import('../iam/dispatcher');

mock.module('../repositories/account-tokens', () => ({
  ...realAccountTokens,
  validateAccountToken: async () => patResult,
}));
mock.module('../repositories/api-keys', () => ({
  ...realApiKeys,
  validateSecretKey: async () => apiKeyResult,
}));
mock.module('../iam/actions', () => ({ ...realIamActions }));
mock.module('../iam/dispatcher', () => ({
  ...realIamDispatcher,
  authorize: async (
    userId: string,
    accountId: string,
    action: string,
    _t: unknown,
    actingTokenId?: string,
  ) => {
    authorizeCalls.push({ userId, accountId, action, actingTokenId });
    return { allowed: authorizeAllowed };
  },
}));

const { authorizeGitProxy } = await import('../projects/lib/git');

beforeEach(() => {
  projectRow = { projectId: PROJECT_ID, accountId: OWNER_ACCOUNT, status: 'active' };
  patResult = { isValid: true, accountId: OWNER_ACCOUNT, userId: 'user-1', tokenId: 'tok-1' };
  apiKeyResult = { isValid: false };
  authorizeAllowed = false;
  authorizeCalls = [];
});

describe('authorizeGitProxy — CLI PAT', () => {
  test('a PAT on the owning account is allowed without an IAM round-trip', async () => {
    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');
    expect(res.ok).toBe(true);
    expect(authorizeCalls).toHaveLength(0);
  });

  test('a PAT on another account passes when the user holds the git capability', async () => {
    patResult = { isValid: true, accountId: OTHER_ACCOUNT, userId: 'user-1', tokenId: 'tok-1' };
    authorizeAllowed = true;

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res.ok).toBe(true);
    // Evaluated against the PROJECT's account, not the token's, and threading
    // the acting token so the agent-grant fold fires.
    expect(authorizeCalls).toEqual([
      {
        userId: 'user-1',
        accountId: OWNER_ACCOUNT,
        action: 'project.gitops.push',
        actingTokenId: 'tok-1',
      },
    ]);
  });

  test('a PAT on another account is denied when the capability is denied', async () => {
    patResult = { isValid: true, accountId: OTHER_ACCOUNT, userId: 'user-1', tokenId: 'tok-1' };
    authorizeAllowed = false;

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  test('read and write map to different capabilities', async () => {
    patResult = { isValid: true, accountId: OTHER_ACCOUNT, userId: 'user-1', tokenId: 'tok-1' };
    authorizeAllowed = true;

    await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'read');

    expect(authorizeCalls[0]?.action).toBe('project.gitops.read');
  });

  test('a project-scoped PAT for a different project is rejected before any capability check', async () => {
    patResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      userId: 'user-1',
      projectId: 'other-project',
    };
    authorizeAllowed = true;

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(authorizeCalls).toHaveLength(0);
  });

  test('an invalid PAT is 401, never a capability lookup', async () => {
    patResult = { isValid: false, error: 'revoked' };

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({ ok: false, status: 401 });
    expect(authorizeCalls).toHaveLength(0);
  });

  test('an archived project is 404 regardless of the token', async () => {
    projectRow = { projectId: PROJECT_ID, accountId: OWNER_ACCOUNT, status: 'archived' };

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});

describe('authorizeGitProxy — account API key', () => {
  test('an API key for another account stays denied — it carries no user to evaluate', async () => {
    patResult = { isValid: false };
    apiKeyResult = { isValid: true, accountId: OTHER_ACCOUNT, type: 'user' };
    authorizeAllowed = true; // would pass IF the fallback applied — it must not

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'write');

    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(authorizeCalls).toHaveLength(0);
  });

  test('an API key on the owning account is allowed', async () => {
    patResult = { isValid: false };
    apiKeyResult = { isValid: true, accountId: OWNER_ACCOUNT, type: 'user' };

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'write');

    expect(res.ok).toBe(true);
  });

  test('a non-Kortix credential is 401', async () => {
    const res = await authorizeGitProxy('ghp_something', PROJECT_ID, 'read');
    expect(res).toMatchObject({ ok: false, status: 401 });
  });
});

/**
 * Every ok-return must carry a `principal`. It is the ONLY input to the git
 * proxy's ref-level protection (R-9.6) — the proxy is not wrapped in
 * combinedAuth, so there is no middleware context to recover it from later. An
 * ok-return that forgot to populate it would either silently disable the
 * control or deny a human's push, depending on which way the classifier fell.
 */
describe('authorizeGitProxy — principal on every ok-return', () => {
  test('a session-bound PAT is a `session` principal (agent)', async () => {
    patResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      userId: 'user-1',
      tokenId: 'tok-1',
      sessionId: 'sandbox-1',
    };

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({
      ok: true,
      principal: { kind: 'session', sessionId: 'sandbox-1', accountId: OWNER_ACCOUNT },
    });
  });

  test('a PAT with only an agentGrant is still a `session` principal', async () => {
    patResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      userId: 'user-1',
      tokenId: 'tok-1',
      agentGrant: { kortixCli: 'all' },
    };

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({ ok: true, principal: { kind: 'session' } });
  });

  test('a PAT with only a serviceAccountId is still a `session` principal', async () => {
    patResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      userId: 'user-1',
      tokenId: 'tok-1',
      serviceAccountId: 'sa-1',
    };

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({ ok: true, principal: { kind: 'session' } });
  });

  test('THE TRAP: a human PROJECT-SCOPED PAT is a `user` principal, not an agent', async () => {
    // `POST /v1/projects/:id/tokens` mints these for humans (`cli · <project>`).
    // Keying on projectId would deny a developer's laptop push.
    patResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      userId: 'user-1',
      tokenId: 'tok-1',
      projectId: PROJECT_ID,
      sessionId: null,
      agentGrant: null,
      serviceAccountId: null,
    };

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');

    expect(res).toMatchObject({
      ok: true,
      principal: { kind: 'user', userId: 'user-1', accountId: OWNER_ACCOUNT },
    });
  });

  test('an unscoped laptop PAT is a `user` principal', async () => {
    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');
    expect(res).toMatchObject({ ok: true, principal: { kind: 'user' } });
  });

  test('a sandbox runtime token is a `sandbox` principal (agent)', async () => {
    patResult = { isValid: false };
    apiKeyResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      type: 'sandbox',
      sandboxId: 'sandbox-1',
      keyId: 'key-1',
    };

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'write');

    expect(res).toMatchObject({
      ok: true,
      principal: { kind: 'sandbox', sandboxId: 'sandbox-1', accountId: OWNER_ACCOUNT },
    });
  });

  test('an account API key is an `api_key` principal', async () => {
    patResult = { isValid: false };
    apiKeyResult = { isValid: true, accountId: OWNER_ACCOUNT, type: 'user', keyId: 'key-1' };

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'write');

    expect(res).toMatchObject({
      ok: true,
      principal: { kind: 'api_key', keyId: 'key-1', accountId: OWNER_ACCOUNT },
    });
  });
});
