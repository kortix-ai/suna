import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realCrypto from '../shared/crypto';
import { Hono } from 'hono';
import * as realPreviewOwnership from '../shared/preview-ownership';
import * as realRequestContext from '../lib/request-context';
import * as realAuthAudit from '../shared/auth-audit';
import * as realSentry from '../lib/sentry';
import * as realSsoSync from '../iam/sso-sync';

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
  // Spread the real module: mock.module replaces it WHOLESALE, and the auth
  // middleware now reaches shared/crypto through oauth/token-hash too.
  ...realCrypto,
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
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => true,
  resolveSandboxProjectId: async (sandboxId: string) =>
    sandboxProjectByOwnSandboxId[sandboxId] ?? null,
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../shared/auth-audit', () => ({
  ...realAuthAudit,
  auditLoginSuccess: () => {},
  auditLoginFail: () => {},
}));

mock.module('../lib/sentry', () => ({ ...realSentry, setSentryUser: () => {} }));
mock.module('../lib/request-context', () => ({ ...realRequestContext, setContextField: () => {} }));
mock.module('../iam/sso-sync', () => ({ ...realSsoSync, syncSsoMembership: async () => {} }));

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
  app.get('/v1/connectors/projects/:projectId/catalog', (c) =>
    c.json({ userId: c.get('userId' as never), projectId: c.req.param('projectId') }),
  );
  app.get('/v1/skills', (c) => c.json({ ok: true }));
  app.get('/v1/skills/:name', (c) => c.json({ ok: true, name: c.req.param('name') }));
  app.get('/v1/skills/:name/file', (c) => c.json({ ok: true }));
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

  test('project-scoped PAT can reach its own canonical /v1/connectors/projects/:id/* routes', async () => {
    const res = await appWithProbe().request(`/v1/connectors/projects/${PROJECT_A}/catalog`, {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).projectId).toBe(PROJECT_A);
  });

  test('project-scoped PAT cannot reach another project through connector routes', async () => {
    const res = await appWithProbe().request(`/v1/connectors/projects/${PROJECT_B}/catalog`, {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Project-scoped token cannot access a different project');
  });

  // The in-sandbox `KORTIX_TOKEN` IS a project+session-scoped PAT, and
  // enforceTokenProjectScope is default-deny. /v1/skills shipped without an
  // allowlist entry, so the one caller the system skills exist for — an agent
  // in a sandbox running the `kortix skills get <name>` that every baked image
  // seeds — got a 403. Nothing caught it: the routes' own unit test mounts the
  // app WITHOUT combinedAuth, and the e2e flow only exercises ANON and a
  // Supabase-JWT owner. These are that regression guard.
  test('project-scoped PAT CAN list the system skills (the in-sandbox agent)', async () => {
    const res = await appWithProbe().request('/v1/skills', {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(200);
  });

  test('project-scoped PAT CAN read a system skill body and a reference file', async () => {
    const body = await appWithProbe().request('/v1/skills/kortix-system', {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });
    expect(body.status).toBe(200);

    const file = await appWithProbe().request(
      '/v1/skills/kortix-system/file?path=references/capabilities.md',
      { headers: { Authorization: 'Bearer kortix_pat_project_a' } },
    );
    expect(file.status).toBe(200);
  });

  test('the /v1/skills allowlist does not leak to a lookalike prefix', async () => {
    const res = await appWithProbe().request('/v1/skillsomething', {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(403);
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
