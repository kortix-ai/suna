import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Two projects under the same account, each with its own sandbox — this is
// the exact shape the security bug needs: a project-scoped PAT for project A
// hitting project B's sandbox must be 403'd even though both projects (and
// both sandboxes) belong to the same account.
const PROJECT_A = 'project-aaa';
const PROJECT_B = 'project-bbb';
const SANDBOX_A = 'sandbox-for-a';
const SANDBOX_B = 'sandbox-for-b';
const ACCOUNT = 'acct-shared';

const sandboxProjectByOwnSandboxId: Record<string, string> = {
  [SANDBOX_A]: PROJECT_A,
  [SANDBOX_B]: PROJECT_B,
};

mock.module('../shared/crypto', () => ({
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
}));

mock.module('../repositories/account-tokens', () => ({
  validateAccountToken: async (t: string) => {
    if (t === 'kortix_pat_project_a') {
      return {
        isValid: true,
        userId: 'user-1',
        accountId: ACCOUNT,
        projectId: PROJECT_A,
        tokenId: 'tok-a',
      };
    }
    if (t === 'kortix_pat_account_scoped') {
      return {
        isValid: true,
        userId: 'user-1',
        accountId: ACCOUNT,
        tokenId: 'tok-account',
      };
    }
    return { isValid: false, error: 'Invalid PAT' };
  },
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false, error: 'Invalid service account' }),
}));

mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async () => ({ isValid: false, error: 'Invalid Kortix token' }),
}));

mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async () => ({ ok: false, reason: 'no-keys' }),
}));

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
  }),
}));

// Sandbox → project resolution, keyed by sandboxId the same way the real
// session_sandboxes lookup would be (uuid/externalId → project_id).
mock.module('../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async () => true,
  resolveSandboxProjectId: async (sandboxId: string) =>
    sandboxProjectByOwnSandboxId[sandboxId] ?? null,
}));

mock.module('../shared/auth-audit', () => ({
  auditLoginSuccess: () => {},
  auditLoginFail: () => {},
}));

mock.module('../lib/sentry', () => ({ setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ setContextField: () => {} }));
mock.module('../iam/sso-sync', () => ({ syncSsoMembership: async () => {} }));

const { combinedAuth } = await import('./auth');

function appWithProbe() {
  const app = new Hono();
  app.use('/*', combinedAuth);
  app.get('/v1/p/:sandboxId/:port/*', (c) =>
    c.json({
      userId: c.get('userId' as never),
      tokenProjectId: c.get('tokenProjectId' as never),
    }),
  );
  app.get('/v1/projects/:projectId', (c) =>
    c.json({ userId: c.get('userId' as never), projectId: c.req.param('projectId') }),
  );
  return app;
}

describe('project-scoped PAT on the sandbox-proxy path', () => {
  beforeEach(() => {});

  test('CAN drive its own project sandbox via /v1/p/{sandboxId}/{port}/...', async () => {
    const res = await appWithProbe().request(`/v1/p/${SANDBOX_A}/8000/turn-stream`, {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('user-1');
    expect(body.tokenProjectId).toBe(PROJECT_A);
  });

  test("CANNOT reach another project's sandbox (403, cross-project blocked)", async () => {
    const res = await appWithProbe().request(`/v1/p/${SANDBOX_B}/8000/turn-stream`, {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain(
      'Project-scoped token cannot access a sandbox outside its project',
    );
  });

  test('a sandbox lookup miss also denies (fail closed, not fail open)', async () => {
    const res = await appWithProbe().request('/v1/p/unknown-sandbox/8000/turn-stream', {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(403);
  });

  test('project-scoped PAT still cannot call unrelated account-level surfaces', async () => {
    const res = await appWithProbe().request('/v1/accounts', {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Project-scoped token cannot call account-level routes');
  });

  test('project-scoped PAT still works unchanged on its own /v1/projects/:id/* REST routes', async () => {
    const res = await appWithProbe().request(`/v1/projects/${PROJECT_A}`, {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectId).toBe(PROJECT_A);
  });

  test('account-scoped PAT (no project binding) reaches the sandbox proxy unchanged', async () => {
    const res = await appWithProbe().request(`/v1/p/${SANDBOX_A}/8000/turn-stream`, {
      headers: { Authorization: 'Bearer kortix_pat_account_scoped' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('user-1');
    expect(body.tokenProjectId).toBeFalsy();
  });
});
