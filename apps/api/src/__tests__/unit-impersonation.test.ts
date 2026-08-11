/**
 * The act-as security gate, exhaustively.
 *
 * Two layers, tested apart on purpose:
 *
 *  1. `decideImpersonation` — pure. Every branch of "may this request act as
 *     this account" runs here with no DB, no Hono, and no clock of its own,
 *     the same way `shouldApplyAdminBypass` is tested in projects/lib/access.
 *  2. `applyImpersonation` — the middleware around it. Asserts what the pure
 *     function cannot: that a denial is a 403 carrying `impersonation_invalid`
 *     and NEVER a silent fall-through, that the request-scoped context is
 *     published on success, and that a mutating request writes its audit row
 *     BEFORE the handler runs.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const state = {
  grant: null as
    | { id: string; adminUserId: string; targetAccountId: string; expiresAt: Date; revokedAt: Date | null }
    | null,
  platformAdmins: new Set<string>(),
  auditEvents: [] as Array<Record<string, unknown>>,
  auditThrows: false,
  handlerRan: 0,
  /** Audit rows present at the moment the handler ran — proves ordering. */
  auditCountWhenHandlerRan: -1,
};

mock.module('../shared/platform-roles', () => ({
  isPlatformAdmin: async (userId: string) => state.platformAdmins.has(userId),
  getPlatformRole: async (userId: string) => (state.platformAdmins.has(userId) ? 'admin' : 'user'),
}));

mock.module('../shared/audit', () => ({
  recordAuditEvent: async (event: Record<string, unknown>) => {
    if (state.auditThrows) throw new Error('audit insert failed');
    state.auditEvents.push(event);
  },
}));

// Everything except the ONE database read is the real module: the pure
// decision, the ALS context, the forbidden-path list. Only `loadImpersonationGrant`
// is replaced, so the middleware test exercises the shipped gate.
const realImpersonation = await import('../shared/impersonation');
mock.module('../shared/impersonation', () => ({
  ...realImpersonation,
  loadImpersonationGrant: async (grantId: string) =>
    state.grant && state.grant.id === grantId ? state.grant : null,
}));

const {
  IMPERSONATION_HEADER,
  IMPERSONATION_INVALID_CODE,
  IMPERSONATION_MAX_TTL_MS,
  decideImpersonation,
  getImpersonationContext,
  impersonatedAccountFor,
  impersonationExpiryFrom,
  isImpersonatingAccount,
  isImpersonationBlockedAccount,
  isImpersonationForbiddenPath,
  setImpersonationContext,
} = realImpersonation;

type ImpersonationContext = NonNullable<ReturnType<typeof getImpersonationContext>>;

const { runWithContext } = await import('../lib/request-context');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';

function grantRow(overrides: Partial<NonNullable<typeof state.grant>> = {}) {
  return {
    id: GRANT,
    adminUserId: ADMIN,
    targetAccountId: TARGET,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    revokedAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-08-11T12:00:00.000Z');

function decide(overrides: Record<string, unknown> = {}) {
  return decideImpersonation({
    grant: grantRow({ expiresAt: new Date(NOW.getTime() + 60_000) }),
    realUserId: ADMIN,
    authType: 'supabase',
    isPlatformAdmin: true,
    path: '/v1/projects',
    // The durable-access entries are method-aware, so the default here is the
    // method they refuse. `/v1/admin/*` is refused for every method.
    method: 'POST',
    now: NOW,
    ...overrides,
  } as Parameters<typeof decideImpersonation>[0]);
}

describe('decideImpersonation', () => {
  test('a live grant held by a current platform admin is allowed', () => {
    expect(decide()).toEqual({ ok: true, grantId: GRANT, targetAccountId: TARGET });
  });

  test('an expired grant is denied — at the instant it expires, not after', () => {
    expect(decide({ grant: grantRow({ expiresAt: NOW }) })).toEqual({
      ok: false,
      reason: 'grant_expired',
    });
    expect(decide({ grant: grantRow({ expiresAt: new Date(NOW.getTime() - 1) }) })).toEqual({
      ok: false,
      reason: 'grant_expired',
    });
  });

  test('a revoked grant is denied even while it is otherwise live', () => {
    expect(decide({ grant: grantRow({ revokedAt: new Date(NOW.getTime() - 1000) }) })).toEqual({
      ok: false,
      reason: 'grant_revoked',
    });
  });

  test("another admin's grant is denied — the id alone is not the capability", () => {
    expect(decide({ grant: grantRow({ adminUserId: OTHER_ADMIN }) })).toEqual({
      ok: false,
      reason: 'grant_not_owned',
    });
  });

  test('a caller who is no longer a platform admin is denied mid-grant', () => {
    expect(decide({ isPlatformAdmin: false })).toEqual({
      ok: false,
      reason: 'not_platform_admin',
    });
  });

  test('an unknown grant id is denied', () => {
    expect(decide({ grant: null })).toEqual({ ok: false, reason: 'grant_not_found' });
  });

  test('only a logged-in human session may act as an account', () => {
    for (const authType of ['pat', 'apiKey', 'service_account', undefined]) {
      expect(decide({ authType })).toEqual({ ok: false, reason: 'auth_type_not_supported' });
    }
  });

  test('the admin console is unreachable from inside a session (no nesting)', () => {
    for (const path of [
      '/v1/admin',
      '/v1/admin/api/accounts',
      '/v1/admin/api/impersonate',
      '/v1/admin/api/accounts/x/overrides',
    ]) {
      expect(decide({ path })).toEqual({ ok: false, reason: 'route_forbidden' });
    }
  });

  test('credential minting is unreachable — a token would outlive the grant', () => {
    for (const path of [
      '/v1/accounts/tokens',
      '/v1/accounts/33333333-3333-4333-8333-333333333333/iam/scim/tokens',
      '/v1/accounts/33333333-3333-4333-8333-333333333333/iam/service-accounts',
      '/v1/projects/abc/cli-token',
      '/v1/projects/abc/git-token',
      '/v1/projects/abc/gateway/keys',
    ]) {
      expect(decide({ path })).toEqual({ ok: false, reason: 'route_forbidden' });
    }
  });

  // Every one of these converts one hour of act-as into access that still
  // works after it, with no banner and no impersonation marker. The membership
  // route is the cheapest: it adds an EXISTING Kortix user straight into the
  // account, optionally as `admin`, with no invite to accept.
  test('durable ACCESS is unreachable too, not just credentials', () => {
    for (const path of [
      '/v1/accounts/33333333-3333-4333-8333-333333333333/members',
      '/v1/accounts/33333333-3333-4333-8333-333333333333/members/some-user',
      '/v1/accounts/33333333-3333-4333-8333-333333333333/invites/abc/resend',
      '/v1/accounts/33333333-3333-4333-8333-333333333333/iam/sso/provider',
      '/v1/accounts/33333333-3333-4333-8333-333333333333/iam/sso/mappings',
      '/v1/projects/p1/sessions/s1/public-shares',
      '/v1/tunnel/connections',
      '/v1/tunnel/connections/t1/rotate-token',
      // Agent governance: both routes commit `kortix.yaml` changes that widen
      // what an agent may read in every future session, outliving the grant.
      '/v1/projects/p1/agents/researcher/scope',
      '/v1/projects/p1/secrets/OPENAI_API_KEY/grant',
    ]) {
      expect(decide({ path })).toEqual({ ok: false, reason: 'route_forbidden' });
    }
  });

  // The list exists to stop CREATION of durable access. A GET creates nothing,
  // and blocking reads would take the member list, the token inventory and the
  // tunnel fleet away from the operator who opened the account to look at them.
  test('reading those same surfaces stays allowed — only writes are refused', () => {
    for (const path of [
      '/v1/accounts/33333333-3333-4333-8333-333333333333/members',
      '/v1/accounts/tokens',
      '/v1/accounts/33333333-3333-4333-8333-333333333333/iam/service-accounts',
      '/v1/tunnel/connections',
    ]) {
      expect(decide({ path, method: 'GET' })).toEqual({
        ok: true,
        grantId: GRANT,
        targetAccountId: TARGET,
      });
      expect(isImpersonationForbiddenPath(path, 'GET')).toBe(false);
      expect(isImpersonationForbiddenPath(path, 'POST')).toBe(true);
    }
  });

  test('the admin console is refused for READS as well', () => {
    expect(decide({ path: '/v1/admin/api/accounts', method: 'GET' })).toEqual({
      ok: false,
      reason: 'route_forbidden',
    });
    expect(isImpersonationForbiddenPath('/v1/admin/api/accounts', 'GET')).toBe(true);
  });

  test('ordinary product routes are not on the forbidden list', () => {
    for (const path of [
      '/v1/projects',
      '/v1/projects/abc',
      '/v1/accounts',
      '/v1/accounts/33333333-3333-4333-8333-333333333333',
      '/v1/billing/account-state',
      '/v1/p/sandbox/8000/session',
      // Near-misses for the new patterns — these must stay reachable.
      '/v1/projects/p1/sessions/s1/messages',
      // Secret CRUD and the agents list are ordinary project surfaces; only
      // the /grant and /scope leaves mint durable agent governance.
      '/v1/projects/p1/secrets',
      '/v1/projects/p1/agents',
      // Audit READ (not the webhooks sub-route) stays open for support.
      '/v1/accounts/33333333-3333-4333-8333-333333333333/audit',
    ]) {
      expect(isImpersonationForbiddenPath(path, 'POST')).toBe(false);
    }
  });

  // Regression guard for the security review of PR6: every route that mints
  // durable access outliving the 1h grant MUST be refused for state changes.
  // A hand-maintained deny-list drifts; this list is the contract.
  test('every durable-access route is refused for state-changing methods', () => {
    const ACC = '/v1/accounts/33333333-3333-4333-8333-333333333333';
    for (const path of [
      // Membership — account-scoped AND project-scoped invite (both INSERT
      // account_members directly / return an invite_url).
      `${ACC}/members`,
      `${ACC}/invites`,
      '/v1/projects/p1/access/invite',
      '/v1/account-invites/abc',
      // IAM durable principals: super-admin PATCH, group/role/policy writes.
      `${ACC}/iam/members/u1/super-admin`,
      `${ACC}/iam/groups/g1/members`,
      `${ACC}/iam/roles`,
      `${ACC}/iam/policies`,
      // Identity the operator could log in through afterwards.
      `${ACC}/iam/sso/provider`,
      `${ACC}/iam/scim/tokens`,
      // Audit exfiltration.
      `${ACC}/audit/webhooks`,
      '/v1/projects/p1/audit/webhooks',
      // Machine credentials — the whole tunnel management surface, incl. the
      // device-auth approve path that the single connections entry missed.
      '/v1/tunnel/connections',
      '/v1/tunnel/device-auth/CODE123/approve',
      '/v1/tunnel/permissions/x',
      // Public shares without expiry = permanent unauthenticated link.
      '/v1/projects/p1/sessions/s1/public-shares',
      // Agent governance written into kortix.yaml.
      '/v1/projects/p1/agents/researcher/scope',
      '/v1/projects/p1/secrets/OPENAI_API_KEY/grant',
    ]) {
      expect(isImpersonationForbiddenPath(path, 'POST'), `POST ${path}`).toBe(true);
    }
  });
});

describe('impersonationExpiryFrom', () => {
  test('defaults to the one-hour ceiling', () => {
    expect(impersonationExpiryFrom(NOW).getTime()).toBe(NOW.getTime() + IMPERSONATION_MAX_TTL_MS);
    expect(IMPERSONATION_MAX_TTL_MS).toBe(60 * 60 * 1000);
  });

  test('a longer request is clamped, a shorter one is honoured', () => {
    expect(impersonationExpiryFrom(NOW, 24 * 60 * 60 * 1000).getTime()).toBe(
      NOW.getTime() + IMPERSONATION_MAX_TTL_MS,
    );
    expect(impersonationExpiryFrom(NOW, 60_000).getTime()).toBe(NOW.getTime() + 60_000);
  });

  test('a nonsense TTL falls back to the ceiling rather than minting a dead grant', () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(impersonationExpiryFrom(NOW, ttl).getTime()).toBe(
        NOW.getTime() + IMPERSONATION_MAX_TTL_MS,
      );
    }
  });
});

describe('request-scoped context', () => {
  test('only the operator named on the grant is widened', () => {
    runWithContext('GET', '/v1/projects', () => {
      setImpersonationContext({
        grantId: GRANT,
        targetAccountId: TARGET,
        impersonatorUserId: ADMIN,
      });
      expect(impersonatedAccountFor(ADMIN)).toBe(TARGET);
      expect(isImpersonatingAccount(ADMIN, TARGET)).toBe(true);
      // A second principal resolved during the same request gets the ordinary
      // answer — this is what keeps a session's creator or a service account
      // from inheriting the operator's grant.
      expect(impersonatedAccountFor(OTHER_ADMIN)).toBeNull();
      expect(isImpersonatingAccount(ADMIN, OTHER_ADMIN)).toBe(false);
      expect(impersonatedAccountFor(null)).toBeNull();
    });
  });

  test('a live grant CONFINES the operator to exactly one account', () => {
    const OPERATOR_OWN = '66666666-6666-4666-8666-666666666666';
    runWithContext('GET', '/v1/projects', () => {
      setImpersonationContext({
        grantId: GRANT,
        targetAccountId: TARGET,
        impersonatorUserId: ADMIN,
      });
      // The target is reachable; the operator's OWN account is not. Without
      // this, "open the app" lands on their last project — theirs — under a
      // banner naming the customer.
      expect(isImpersonationBlockedAccount(ADMIN, TARGET)).toBe(false);
      expect(isImpersonationBlockedAccount(ADMIN, OPERATOR_OWN)).toBe(true);
      // Nobody else is confined by someone else's grant.
      expect(isImpersonationBlockedAccount(OTHER_ADMIN, OPERATOR_OWN)).toBe(false);
      expect(isImpersonationBlockedAccount(null, OPERATOR_OWN)).toBe(false);
    });
  });

  test('no grant means no confinement at all', () => {
    runWithContext('GET', '/v1/projects', () => {
      expect(isImpersonationBlockedAccount(ADMIN, TARGET)).toBe(false);
    });
  });

  test('there is no ambient context outside a request', () => {
    expect(getImpersonationContext()).toBeNull();
    expect(impersonatedAccountFor(ADMIN)).toBeNull();
    expect(setImpersonationContext({
      grantId: GRANT,
      targetAccountId: TARGET,
      impersonatorUserId: ADMIN,
    })).toBe(false);
  });

  test('context does not leak between requests', () => {
    runWithContext('GET', '/v1/projects', () => {
      setImpersonationContext({
        grantId: GRANT,
        targetAccountId: TARGET,
        impersonatorUserId: ADMIN,
      });
    });
    runWithContext('GET', '/v1/projects', () => {
      expect(getImpersonationContext()).toBeNull();
    });
  });
});

// ─── Middleware ──────────────────────────────────────────────────────────────

const { applyImpersonation } = await import('../middleware/impersonation');

interface FakeContextOptions {
  header?: string;
  method?: string;
  path?: string;
  userId?: string;
  authType?: string;
}

function fakeContext(options: FakeContextOptions = {}) {
  const vars = new Map<string, unknown>();
  vars.set('userId', options.userId ?? ADMIN);
  vars.set('authType', options.authType ?? 'supabase');
  return {
    vars,
    req: {
      method: options.method ?? 'GET',
      path: options.path ?? '/v1/projects',
      routePath: options.path ?? '/v1/projects',
      header: (name: string) =>
        name.toLowerCase() === IMPERSONATION_HEADER ? options.header : undefined,
    },
    get: (key: string) => vars.get(key),
    set: (key: string, value: unknown) => vars.set(key, value),
  };
}

async function run(options: FakeContextOptions = {}) {
  const c = fakeContext(options);
  // A mutable record, not two `let`s: TypeScript narrows a `let` that is only
  // ever assigned inside a callback down to its initializer's type, which made
  // `out.context` read as `null` at every call site.
  const captured: { context: ImpersonationContext | null; accountIdSeenByHandler: unknown } = {
    context: null,
    accountIdSeenByHandler: undefined,
  };
  const result = await runWithContext(c.req.method, c.req.path, async () => {
    try {
      await applyImpersonation(c as never, async () => {
        state.handlerRan += 1;
        state.auditCountWhenHandlerRan = state.auditEvents.length;
        captured.context = getImpersonationContext();
        captured.accountIdSeenByHandler = c.get('accountId');
      });
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: error as { status?: number; res?: Response } };
    }
  });
  return { ...result, c, ...captured };
}

describe('applyImpersonation', () => {
  beforeEach(() => {
    state.grant = grantRow();
    state.platformAdmins = new Set([ADMIN, OTHER_ADMIN]);
    state.auditEvents = [];
    state.auditThrows = false;
    state.handlerRan = 0;
    state.auditCountWhenHandlerRan = -1;
  });

  test('no header → untouched request, no context, no audit', async () => {
    const out = await run();
    expect(out.ok).toBe(true);
    expect(state.handlerRan).toBe(1);
    expect(out.context).toBeNull();
    expect(state.auditEvents).toHaveLength(0);
  });

  test('a valid grant publishes the target account to the handler', async () => {
    const out = await run({ header: GRANT });
    expect(out.ok).toBe(true);
    expect(out.context).toEqual({
      grantId: GRANT,
      targetAccountId: TARGET,
      impersonatorUserId: ADMIN,
    });
    expect(out.accountIdSeenByHandler).toBe(TARGET);
    expect(out.c.get('impersonatorUserId')).toBe(ADMIN);
  });

  async function expectDenied(options: FakeContextOptions) {
    const out = await run(options);
    expect(out.ok).toBe(false);
    expect(state.handlerRan).toBe(0);
    expect((out as { error: { status?: number } }).error.status).toBe(403);
    const body = await (out as { error: { res?: Response } }).error.res!.clone().json();
    expect(body.code).toBe(IMPERSONATION_INVALID_CODE);
    return out;
  }

  test('an expired grant denies with 403 impersonation_invalid', async () => {
    state.grant = grantRow({ expiresAt: new Date(Date.now() - 1000) });
    await expectDenied({ header: GRANT });
  });

  test('a revoked grant denies', async () => {
    state.grant = grantRow({ revokedAt: new Date() });
    await expectDenied({ header: GRANT });
  });

  test("another admin's grant denies", async () => {
    state.grant = grantRow({ adminUserId: OTHER_ADMIN });
    await expectDenied({ header: GRANT });
  });

  test('a real user who is not a platform admin denies', async () => {
    state.platformAdmins = new Set();
    await expectDenied({ header: GRANT });
  });

  test('an unknown grant id denies', async () => {
    await expectDenied({ header: '55555555-5555-4555-8555-555555555555' });
  });

  test('a non-JWT credential carrying the header denies', async () => {
    await expectDenied({ header: GRANT, authType: 'pat' });
    await expectDenied({ header: GRANT, authType: 'apiKey' });
  });

  test('an impersonated request may not reach /v1/admin', async () => {
    await expectDenied({ header: GRANT, path: '/v1/admin/api/impersonate', method: 'POST' });
    await expectDenied({ header: GRANT, path: '/v1/admin/api/accounts' });
  });

  test('an impersonated request may not mint a durable credential', async () => {
    await expectDenied({ header: GRANT, path: '/v1/accounts/tokens', method: 'POST' });
    await expectDenied({ header: GRANT, path: '/v1/projects/p1/cli-token', method: 'POST' });
  });

  test('a denial never falls back to the operator own account', async () => {
    state.grant = grantRow({ expiresAt: new Date(Date.now() - 1000) });
    const out = await run({ header: GRANT });
    expect(out.ok).toBe(false);
    expect(out.c.get('accountId')).toBeUndefined();
    expect(state.handlerRan).toBe(0);
  });

  test('a mutating request writes the dual-identity audit row BEFORE the handler', async () => {
    await run({ header: GRANT, method: 'POST', path: '/v1/projects' });
    expect(state.auditEvents).toHaveLength(1);
    // The handler saw the row already committed — an audit written on the way
    // out could be skipped by a handler that never returns.
    expect(state.auditCountWhenHandlerRan).toBe(1);
    const event = state.auditEvents[0] as Record<string, any>;
    expect(event.action).toBe('admin.impersonate.action');
    expect(event.accountId).toBe(TARGET);
    expect(event.actorUserId).toBe(ADMIN);
    expect(event.metadata.impersonator_user_id).toBe(ADMIN);
    expect(event.metadata.target_account_id).toBe(TARGET);
    expect(event.metadata.grant_id).toBe(GRANT);
    expect(event.metadata.method).toBe('POST');
    expect(event.metadata.path).toBe('/v1/projects');
  });

  test('PATCH / PUT / DELETE are audited; GET and HEAD are not', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      state.auditEvents = [];
      await run({ header: GRANT, method });
      expect(state.auditEvents).toHaveLength(1);
    }
    for (const method of ['GET', 'HEAD']) {
      state.auditEvents = [];
      await run({ header: GRANT, method });
      expect(state.auditEvents).toHaveLength(0);
    }
  });

  test('a failing audit insert does not deny an already-authorized action', async () => {
    state.auditThrows = true;
    const out = await run({ header: GRANT, method: 'POST' });
    expect(out.ok).toBe(true);
    expect(state.handlerRan).toBe(1);
  });
});
