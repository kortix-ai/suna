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
let sandboxRow: Record<string, unknown> | null = null;
let monitorBoxRow: Record<string, unknown> | null = null;
let authorizeAllowed = false;
let authorizeCalls: Array<{
  userId: string;
  accountId: string;
  action: string;
  actingTokenId?: string;
}> = [];

mock.module('../shared/db', () => ({
  db: {
    select: (fields?: Record<string, unknown>) => {
      const rows = fields?.sessionMetadata
        ? () => (sandboxRow ? [sandboxRow] : [])
        : fields?.boxEpoch
          ? () => (monitorBoxRow ? [monitorBoxRow] : [])
          : () => (projectRow ? [projectRow] : []);
      return {
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => rows() }) }),
          // Monitor-box lookup (loadMonitorBoxForToken) has no join.
          where: () => ({ limit: async () => rows() }),
        }),
      };
    },
  },
  hasDatabase: true,
}));
// Spread the real modules and override only the seams under test — replacing
// them wholesale would strip exports other importers in this process need.
const realAccountTokens = await import('../repositories/account-tokens');
const realApiKeys = await import('../repositories/api-keys');
const realIamActions = await import('../iam/actions');
const realIamAuthorize = await import('../iam/authorize');

let validateCalls = 0;
mock.module('../repositories/account-tokens', () => ({
  ...realAccountTokens,
  validateAccountToken: async () => {
    validateCalls += 1;
    return patResult;
  },
}));
mock.module('../repositories/api-keys', () => ({
  ...realApiKeys,
  validateSecretKey: async () => apiKeyResult,
}));
mock.module('../iam/actions', () => ({ ...realIamActions }));
mock.module('../iam/authorize', () => ({
  ...realIamAuthorize,
  // The acting token is now part of the Actor's credential, not a trailing
  // argument — this assertion is the point of the test, so read it back out of
  // the credential the git proxy built.
  authorize: async (
    actor: { userId: string; accountId: string; credential: { tokenId?: string } },
    action: string,
  ) => {
    authorizeCalls.push({
      userId: actor.userId,
      accountId: actor.accountId,
      action,
      actingTokenId: actor.credential.tokenId,
    });
    return { allowed: authorizeAllowed, reason: 'role' };
  },
}));

const { authorizeGitProxy, __resetGitProxyAuthzMemoForTests } = await import('../projects/lib/git');

beforeEach(() => {
  __resetGitProxyAuthzMemoForTests();
  projectRow = { projectId: PROJECT_ID, accountId: OWNER_ACCOUNT, status: 'active' };
  patResult = { isValid: true, accountId: OWNER_ACCOUNT, userId: 'user-1', tokenId: 'tok-1' };
  apiKeyResult = { isValid: false };
  sandboxRow = null;
  authorizeAllowed = false;
  authorizeCalls = [];
});

describe('authorizeGitProxy — CLI PAT', () => {
  test('a PAT on the owning account is allowed without an IAM round-trip', async () => {
    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'write');
    expect(res.ok).toBe(true);
    expect(authorizeCalls).toHaveLength(0);
  });

  test('a session PAT for a runtime workspace is denied before account ownership can allow it', async () => {
    patResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      userId: 'user-1',
      tokenId: 'tok-1',
      projectId: PROJECT_ID,
      sessionId: 'sandbox-1',
    };
    sandboxRow = {
      sandboxId: 'sandbox-1',
      sessionMetadata: { workspace_mode: 'runtime' },
    };

    const res = await authorizeGitProxy('kortix_pat_x', PROJECT_ID, 'read');

    expect(res).toMatchObject({
      ok: false,
      status: 403,
      message: 'session workspace does not allow repository access',
    });
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

describe('authorizeGitProxy — sandbox token', () => {
  beforeEach(() => {
    patResult = { isValid: false };
    apiKeyResult = {
      isValid: true,
      accountId: OWNER_ACCOUNT,
      type: 'sandbox',
      sandboxId: 'sandbox-1',
    };
  });

  test('runtime sessions cannot read Git objects', async () => {
    sandboxRow = {
      sandboxId: 'sandbox-1',
      sessionMetadata: { workspace_mode: 'runtime' },
    };

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'read');

    expect(res).toMatchObject({
      ok: false,
      status: 403,
      message: 'sandbox workspace does not allow Git access',
    });
  });

  test('branch sessions retain Git access', async () => {
    sandboxRow = {
      sandboxId: 'sandbox-1',
      sessionMetadata: { workspace_mode: 'branch' },
    };

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'write');

    expect(res.ok).toBe(true);
  });

  test('legacy sessions without a workspace mode retain Git access', async () => {
    sandboxRow = { sandboxId: 'sandbox-1', sessionMetadata: {} };

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'read');

    expect(res.ok).toBe(true);
  });

  // A monitor box has NO session_sandboxes row by design — its token scopes
  // against project_monitor_boxes (docs/specs/2026-08-12-monitors.md). Caught
  // live on dev 2026-08-12: the box could not clone and no monitor ever ran.
  test('a live monitor box clones through the proxy without a session row', async () => {
    sandboxRow = null;
    monitorBoxRow = {
      boxId: 'sandbox-1',
      projectId: PROJECT_ID,
      boxEpoch: 'epoch-1',
    };

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'read');

    expect(res.ok).toBe(true);
  });

  test('a sandbox token with neither a session nor a monitor box stays denied', async () => {
    sandboxRow = null;
    monitorBoxRow = null;

    const res = await authorizeGitProxy('kortix_abc', PROJECT_ID, 'read');

    expect(res).toMatchObject({
      ok: false,
      status: 403,
      message: 'sandbox token is not scoped to this project',
    });
  });
});

describe('authorizeGitProxy — verdict memo', () => {
  test("a positive verdict is reused for the clone's follow-up requests without re-validating", async () => {
    validateCalls = 0;
    patResult = { isValid: true, accountId: OWNER_ACCOUNT, userId: 'user-1', tokenId: 'tok-1' };
    const first = await authorizeGitProxy('kortix_pat_memo', PROJECT_ID, 'read');
    expect(first.ok).toBe(true);
    expect(validateCalls).toBe(1);
    // Same token+project+scope inside the TTL → memoized, no second validation
    // even though the token would now be refused.
    patResult = { isValid: false, error: 'revoked' };
    const second = await authorizeGitProxy('kortix_pat_memo', PROJECT_ID, 'read');
    expect(second.ok).toBe(true);
    expect(validateCalls).toBe(1);
    // A different scope is a fresh verdict — and sees the revocation.
    const write = await authorizeGitProxy('kortix_pat_memo', PROJECT_ID, 'write');
    expect(write.ok).toBe(false);
    expect(validateCalls).toBe(2);
  });

  test('denials are never memoized', async () => {
    patResult = { isValid: false, error: 'revoked' };
    const denied = await authorizeGitProxy('kortix_pat_denied', PROJECT_ID, 'read');
    expect(denied.ok).toBe(false);
    patResult = { isValid: true, accountId: OWNER_ACCOUNT, userId: 'user-1', tokenId: 'tok-1' };
    const allowed = await authorizeGitProxy('kortix_pat_denied', PROJECT_ID, 'read');
    expect(allowed.ok).toBe(true);
  });
});
