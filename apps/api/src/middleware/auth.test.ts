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
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';

const sandboxProjectByOwnSandboxId: Record<string, string> = {
  [SANDBOX_A]: PROJECT_A,
  [SANDBOX_B]: PROJECT_B,
};

mock.module('../shared/crypto', () => ({
  // Spread the real module: mock.module replaces it WHOLESALE, so every
  // export that a transitively imported module uses must stay present.
  ...realCrypto,
  isAccountToken: (t: string) => t.startsWith('kortix_pat_'),
  isServiceAccountToken: (t: string) => t.startsWith('kortix_sa_'),
  isKortixToken: (t: string) => t.startsWith('kortix_'),
  isTunnelToken: (t: string) => t.startsWith('kortix_tun_'),
  isApiKeySecretConfigured: () => true,
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
    if (t === 'kortix_pat_session_bound_a') {
      // The in-sandbox KORTIX_TOKEN shape: project+SESSION-scoped
      // ("One sandbox, one session-scoped Kortix credential").
      return {
        isValid: true,
        userId: 'user-1',
        accountId: ACCOUNT,
        projectId: PROJECT_A,
        sessionId: SANDBOX_A,
        tokenId: 'tok-session-a',
      };
    }
    return { isValid: false, error: 'Invalid PAT' };
  },
}));

mock.module('../repositories/service-accounts', () => ({
  validateServiceAccountToken: async () => ({ isValid: false, error: 'Invalid service account' }),
}));

// `kortix_sb_attachment_runtime` is the legacy sandbox key the project-scope
// tests use; `kortix_owner`/`kortix_other` are the preview-ownership tests'
// account-holding Kortix tokens below. Distinct literal tokens, one function.
mock.module('../repositories/api-keys', () => ({
  validateSecretKey: async (token: string) => {
    if (token === 'kortix_sb_attachment_runtime') {
      return {
        isValid: true,
        type: 'sandbox',
        sandboxId: SANDBOX_A,
        accountId: ACCOUNT,
        keyId: 'legacy-key',
      };
    }
    if (token === 'kortix_owner') return { isValid: true, accountId: 'acct-owner' };
    if (token === 'kortix_other') return { isValid: true, accountId: 'acct-other' };
    return { isValid: false, error: 'Invalid Kortix token' };
  },
}));

// `no-keys` is inconclusive (see shared/jwt-verify-outcome.ts) and falls
// through to the shared/supabase network mock below; the preview-ownership
// tests' jwt-* tokens get their own verdicts, everything else (incl. the
// project-scope tests' non-Kortix bearer) keeps the original always-fall-through
// behavior.
mock.module('../shared/jwt-verify', () => ({
  decodeSupabaseJwtPayload: () => null,
  verifySupabaseJwt: async (token: string) => {
    if (token === 'jwt-owner') return { ok: true, userId: 'user-owner', email: 'owner@kortix.dev' };
    if (token === 'jwt-other') return { ok: true, userId: 'user-other', email: 'other@kortix.dev' };
    // jwt-fallback-{owner,other} AND every other/unrecognized bearer (e.g. the
    // project-scope tests' plain JWT-shaped token): local verification can't
    // judge it, so it falls through to the shared/supabase network mock above.
    return { ok: false, reason: 'no-keys' };
  },
}));

/** Supabase network-fallback user, for the jwt-fallback-* rows below. Unused
 * (stays null) by every other test, reproducing the original always-401 stub. */
let mockSupabaseUser: { id: string; email?: string } | null = null;

mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: {
      getUser: async () => ({
        data: { user: mockSupabaseUser },
        error: mockSupabaseUser ? null : { message: 'invalid' },
      }),
    },
  }),
}));

/** The account that owns every sandbox in the preview-ownership describe below,
 * or null for "no such sandbox". Unused (and inert) by every other test. */
let mockSandboxAccountId: string | null = 'acct-owner';
/** Signed-in people who belong to that owning account. */
const OWNING_USERS = new Set(['user-owner', 'user-fallback-owner']);

// Sandbox → project resolution (project-scope tests) and sandbox → owning
// account / user (preview-ownership tests) are two different real functions on
// two different combinedAuth branches (PAT vs Kortix-token/JWT) that never both
// fire for the same request — one mock module, no interference.
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async ({ accountId, userId }: { accountId?: string; userId?: string }) => {
    if (!mockSandboxAccountId) return false;
    if (accountId) return accountId === mockSandboxAccountId;
    return !!userId && OWNING_USERS.has(userId);
  },
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

const { combinedAuth, supabaseAuth } = await import('./auth');

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
  // The preview-ownership describe block's one non-sandbox-shaped route: it
  // must NOT be parsed as `/v1/p/:sandboxId/:port` (no ownership check applies).
  app.post('/v1/p/share', (c) => c.json({ ok: true }));
  app.post('/v1/platform/runtime-projection', (c) =>
    c.json({
      ok: true,
      sandboxId: c.get('sandboxId' as never),
      sessionId: c.get('sessionId' as never),
    }),
  );
  app.post('/v1/platform/boot-timeline', (c) =>
    c.json({
      ok: true,
      sandboxId: c.get('sandboxId' as never),
      sessionId: c.get('sessionId' as never),
    }),
  );
  app.get('/v1/skills/:name', (c) => c.json({ ok: true, name: c.req.param('name') }));
  app.get('/v1/skills/:name/file', (c) => c.json({ ok: true }));
  return app;
}

function appWithSandboxDescriptorProbe() {
  const app = new Hono();
  app.use('/*', supabaseAuth);
  app.get('/v1/projects/:projectId/runtime/prompt-attachments/:attachmentId', (c) =>
    c.json({ sandboxId: c.get('sandboxId' as never) }),
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

  // The runtime-projection sink is called by the daemon holding the in-sandbox
  // KORTIX_TOKEN — a project+SESSION-scoped PAT. enforceTokenProjectScope is
  // default-deny, so without an explicit allowance the push 403s before the
  // handler's own isSessionSandboxCredential check ever runs (observed live:
  // POST /v1/platform/runtime-projection -> 403 "Project-scoped token cannot
  // call this surface" from a real Platinum box, 2026-08-27).
  test('a session-BOUND project PAT reaches the runtime-projection sink', async () => {
    const res = await appWithProbe().request('/v1/platform/runtime-projection', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_session_bound_a' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // The handler's isSessionSandboxCredential needs both, equal.
    expect(body.sessionId).toBe(SANDBOX_A);
    expect(body.sandboxId).toBe(SANDBOX_A);
  });

  test('a plain project PAT (no session binding) still cannot reach the sink', async () => {
    const res = await appWithProbe().request('/v1/platform/runtime-projection', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Project-scoped token cannot call this surface');
  });

  // Same defect as runtime-projection above, one route over, and it reached
  // production: `POST /v1/platform/boot-timeline -> 403 [HTTPException]` fired
  // 2,338 times in the 7 days to 2026-09-09 (1,414 in the last two days) against
  // 47 successes. The route IS in `sandboxTokenPathAllowed`, but that allowlist
  // only governs `kortix_`/`kortix_sb_` API keys — and prod minted 583
  // session-scoped PATs and ZERO sandbox API keys in that window, so every
  // modern box was judged by enforceTokenProjectScope's default-deny instead.
  test('a session-BOUND project PAT reaches the boot-timeline sink', async () => {
    const res = await appWithProbe().request('/v1/platform/boot-timeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_session_bound_a' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // The handler's isSessionSandboxCredential needs both, equal.
    expect(body.sessionId).toBe(SANDBOX_A);
    expect(body.sandboxId).toBe(SANDBOX_A);
  });

  test('a plain project PAT (no session binding) still cannot reach boot-timeline', async () => {
    const res = await appWithProbe().request('/v1/platform/boot-timeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Project-scoped token cannot call this surface');
  });

  // The denial must name WHY: which check rejected, and which principal it
  // rejected. Without this the global onError line (`-> 403 [HTTPException]`)
  // is the same string for a cross-project attempt, a foreign sandbox, and an
  // unmounted daemon sink.
  test('a scope denial names the check and the principal that was rejected', async () => {
    const res = await appWithProbe().request('/v1/platform/boot-timeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });
    const text = await res.text();

    expect(text).toContain('check=token-project-scope:default-deny');
    expect(text).toContain('principal=project-scoped-pat');
    expect(text).toContain(`project=${PROJECT_A}`);
    expect(text).toContain('path=/v1/platform/boot-timeline');
  });

  test('a cross-project denial names its own check, not the default-deny', async () => {
    const res = await appWithProbe().request(`/v1/projects/${PROJECT_B}`, {
      headers: { Authorization: 'Bearer kortix_pat_project_a' },
    });
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(text).toContain('check=token-project-scope:cross-project');
    expect(text).not.toContain('default-deny');
  });
});

describe('legacy sandbox credential route allowlist', () => {
  test('accepts only the exact runtime prompt attachment descriptor path', async () => {
    const exact = await appWithSandboxDescriptorProbe().request(
      `/v1/projects/${PROJECT_A}/runtime/prompt-attachments/${ATTACHMENT_ID}`,
      { headers: { Authorization: 'Bearer kortix_sb_attachment_runtime' } },
    );
    expect(exact.status).toBe(200);
    expect((await exact.json()).sandboxId).toBe(SANDBOX_A);

    for (const path of [
      `/v1/projects/${PROJECT_A}/runtime/prompt-attachments`,
      `/v1/projects/${PROJECT_A}/runtime/prompt-attachments/${ATTACHMENT_ID}/extra`,
      `/v1/projects/${PROJECT_A}/runtime/prompt-attachments-not/${ATTACHMENT_ID}`,
    ]) {
      const response = await appWithSandboxDescriptorProbe().request(path, {
        headers: { Authorization: 'Bearer kortix_sb_attachment_runtime' },
      });
      expect(response.status).toBe(401);
    }
  });
});

describe('unknown-token attempt budget (pre-authentication, per client IP)', () => {
  const { config } = require('../config') as { config: Record<string, unknown> };
  const { resetTokenAttemptBudget } = require('./token-attempt-budget') as {
    resetTokenAttemptBudget: () => void;
  };

  function supabaseApp() {
    const app = new Hono();
    app.use('/*', supabaseAuth);
    app.get('/v1/projects/:projectId', (c) => c.json({ ok: true }));
    return app;
  }

  test('an address that keeps presenting unknown tokens is refused before any hashing', async () => {
    resetTokenAttemptBudget();
    config.KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN = '3';
    try {
      const app = supabaseApp();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await app.request('/v1/projects/p1', {
          headers: {
            Authorization: `Bearer kortix_pat_unknown_${i}`,
            'x-forwarded-for': `10.9.9.${i}, 203.0.113.50, 172.70.1.2`,
          },
        });
        statuses.push(res.status);
        if (res.status === 429) expect(res.headers.get('Retry-After')).toBeTruthy();
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);

      // Another caller behind the same proxies keeps its own budget.
      const other = await app.request('/v1/projects/p1', {
        headers: {
          Authorization: 'Bearer kortix_pat_unknown_other',
          'x-forwarded-for': '198.51.100.60, 172.70.1.2',
        },
      });
      expect(other.status).toBe(401);
    } finally {
      delete config.KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN;
      resetTokenAttemptBudget();
    }
  });

  test('the budget also guards combinedAuth and ignores non-Kortix bearers', async () => {
    resetTokenAttemptBudget();
    config.KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN = '1';
    try {
      const app = appWithProbe();
      const headers = (token: string) => ({
        Authorization: `Bearer ${token}`,
        'x-forwarded-for': '203.0.113.51, 172.70.1.2',
      });
      expect((await app.request('/v1/projects/p1', { headers: headers('kortix_pat_x1') })).status).toBe(401);
      expect((await app.request('/v1/projects/p1', { headers: headers('kortix_pat_x2') })).status).toBe(429);
      // A Supabase JWT never costs a scrypt, so the budget never refuses it.
      expect((await app.request('/v1/projects/p1', { headers: headers('eyJhbGciOi.jwt.sig') })).status).toBe(401);
    } finally {
      delete config.KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN;
      resetTokenAttemptBudget();
    }
  });
});

// `combinedAuth` on the path-form preview proxy (`/v1/p/:sandboxId/:port/*`):
// which credential shapes it accepts, and how the ownership verdict maps to
// 401/403/200 for each token branch. The ownership RULE itself runs on real
// rows in __tests__/integration-preview-access.test.ts; here it is a verdict
// this suite chooses.
describe('preview auth ownership', () => {
  const OWNED_SANDBOX = '8c70e5be-2f95-45ae-bd8d-5d07b65c631b';

  beforeEach(() => {
    mockSandboxAccountId = 'acct-owner';
    mockSupabaseUser = null;
  });

  test('rejects request without auth token', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`);
    expect(res.status).toBe(401);
  });

  test('allows owner via Bearer kortix token', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { Authorization: 'Bearer kortix_owner' },
    });
    expect(res.status).toBe(200);
  });

  test('allows owner via X-Kortix-Token header', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { 'X-Kortix-Token': 'kortix_owner' },
    });
    expect(res.status).toBe(200);
  });

  test('allows owner via preview session cookie with kortix token', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { Cookie: '__preview_session=kortix_owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects query-string bearer tokens on ordinary HTTP preview routes', async () => {
    const res = await appWithProbe().request(
      `/v1/p/${OWNED_SANDBOX}/8000/session/status?token=kortix_owner`,
    );
    expect(res.status).toBe(401);
  });

  test('rejects non-owner kortix token', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { Authorization: 'Bearer kortix_other' },
    });
    expect(res.status).toBe(403);
  });

  test('rejects invalid X-Kortix-Token', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { 'X-Kortix-Token': 'kortix_invalid' },
    });
    expect(res.status).toBe(401);
  });

  test('allows jwt owner with matching account ownership', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { Authorization: 'Bearer jwt-owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects jwt user without ownership', async () => {
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { Authorization: 'Bearer jwt-other' },
    });
    expect(res.status).toBe(403);
  });

  test('allows jwt owner via Supabase fallback path', async () => {
    mockSupabaseUser = { id: 'user-fallback-owner', email: 'fallback@kortix.dev' };
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { Authorization: 'Bearer jwt-fallback-owner' },
    });
    expect(res.status).toBe(200);
  });

  test('rejects jwt via Supabase fallback without ownership', async () => {
    mockSupabaseUser = { id: 'user-fallback-other', email: 'other@kortix.dev' };
    const res = await appWithProbe().request(`/v1/p/${OWNED_SANDBOX}/8000/session/status`, {
      headers: { Authorization: 'Bearer jwt-fallback-other' },
    });
    expect(res.status).toBe(403);
  });

  test('does not treat /v1/p/share as a sandbox ownership route', async () => {
    mockSandboxAccountId = null;
    const res = await appWithProbe().request('/v1/p/share', {
      method: 'POST',
      headers: { Authorization: 'Bearer kortix_owner' },
    });
    expect(res.status).toBe(200);
  });
});
