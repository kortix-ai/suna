/**
 * Route-level tests for the preview proxy (`/v1/p/:sandboxId/:port/*`) and its
 * WebSocket upgrade, through the mounted Hono app and a fake network.
 *
 * Tests: port validation, ownership, session gates, forwarding and header
 *        hygiene, provider credential recovery, CORS, auto-wake, retries,
 *        hop attribution, the SSE stall bypass, and the PTY live-port lookup.
 *
 * Strategy:
 * - mock.module() replaces auth, DB, IAM, providers and global fetch
 * - Auth is bypassed (userId injected directly; a test header names a
 *   session-bound caller)
 * - DB queries are mocked to simulate ownership checks
 * - Global fetch is mocked to simulate upstream responses
 *
 * The provider's routing rule (which effective port a request lands on) is
 * owned by the provider suites; this file proves the proxy's plumbing around
 * whatever the provider answers. Unauthenticated 401 through the REAL auth
 * middleware is the SEC-G flow.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { runWithContext } from '../lib/request-context';
import { classifyPtyWebSocketPath } from '../platform/providers/pty-ingress';
import * as realProviders from '../platform/providers';
import * as realPreviewOwnership from '../shared/preview-ownership';
import { __resetPromptModelSignatureCacheForTests } from '../projects/lib/sandbox-env-sync';

// ─── Mock state ──────────────────────────────────────────────────────────────

const TEST_USER_ID = '00000000-0000-4000-a000-000000000001';
const TEST_SANDBOX_ID = 'sandbox-abc-123';
const TEST_SESSION_SANDBOX_ID = '11111111-1111-4111-8111-111111111111';
const TEST_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const TEST_SERVICE_KEY = 'test-service-key-123';
const TEST_PORT = 8080;

let mockDbSandbox: any = {
  sandboxId: TEST_SESSION_SANDBOX_ID,
  projectId: TEST_PROJECT_ID,
  accountId: 'account-001',
  agentName: 'default',
  status: 'active',
  config: { serviceKey: TEST_SERVICE_KEY },
  provider: 'daytona',
  baseUrl: null,
};
let mockDbMembership: any = { accountRole: 'member' };
let mockPreviewUrl = 'https://preview.daytona.io/proxy-url';
let mockPreviewToken: string | null = 'daytona-preview-token-123';
let mockWakeCalls: string[] = [];
let mockFetchResponses: Array<{
  status: number;
  body: string;
  headers?: Record<string, string>;
  error?: Error;
}> = [];
let mockFetchCallCount = 0;
let mockFetchCalls: Array<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | null;
}> = [];
let mockDbUpdateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
let mockResolvedPreviewPorts: number[] = [];
/** When set, every provider ingress resolution throws it. */
let mockResolveIngressError: Error | null = null;
let mockSnapshotSyncCalls: Array<Record<string, unknown>> = [];

function mockSandboxRows(): any[] {
  if (!mockDbSandbox) return [];
  return Array.isArray(mockDbSandbox) ? mockDbSandbox : [mockDbSandbox];
}

// ─── Register mocks ──────────────────────────────────────────────────────────

// Auth mock — bypass combinedAuth
mock.module('../middleware/auth', () => ({
  combinedAuth: async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    const cookieHeader = c.req.header('Cookie') || '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)__preview_session=([^;]+)/);
    const hasCookie = !!cookieMatch;
    if (!authHeader?.startsWith('Bearer ') && !hasCookie) {
      throw new HTTPException(401, { message: 'Missing authentication token' });
    }
    c.set('userId', TEST_USER_ID);
    c.set('userEmail', 'test@kortix.dev');
    // A session-bound token (a sandbox token) names the session it was minted
    // for; the per-session gates narrow on it.
    const callerSession = c.req.header('X-Test-Caller-Session');
    if (callerSession) {
      c.set('authType', 'pat');
      c.set('sessionId', callerSession);
    }
    await next();
  },
  supabaseAuth: async (c: any, next: any) => {
    await next();
  },
  apiKeyAuth: async (c: any, next: any) => {
    await next();
  },
}));

// DB mock — simulate sandbox + membership queries
// Uses field-aware matching: inspects the `select` fields to determine which
// mock to return (accountId → sandbox table, accountRole → membership table).
// This is more resilient to query reordering than the old call-counter approach.
mock.module('../shared/db', () => {
  return {
    hasDatabase: true,
    db: {
      select: (fields: any) => {
        // Determine which table is being queried by inspecting selected fields
        // The preview proxy selects several session_sandboxes projections and
        // { accountRole } from account_members.
        const fieldKeys = fields ? Object.keys(fields) : [];
        // `createdBy` is the unambiguous signal for the projectSessions
        // owner/agent lookup (sandbox-env-sync.ts) — check it BEFORE the loose
        // sandbox-field check below, since that query also selects `agentName`
        // (a field the sandbox-row query shape shares), which would otherwise
        // misclassify it as a sandbox-table query and starve resolveOwnerRawEnv.
        const isProjectSessionQuery = fieldKeys.includes('createdBy');
        // `wakeSandbox`'s deadline probe: a one-column projection of
        // session_sandboxes. It must be classified BEFORE the loose sandbox
        // check and served a LIVE deadline, otherwise every wake in this file is
        // refused as expired and the auto-wake/retry assertions all fail. The
        // refusal path itself is covered in sandbox-proxy/wake-deadline-guard.test.ts.
        const isDeadlineProbe = fieldKeys.length === 1 && fieldKeys[0] === 'deadlineAt';
        const isSandboxQuery =
          !isDeadlineProbe &&
          !isProjectSessionQuery &&
          fieldKeys.some((key) =>
            [
              'accountId',
              'sandboxId',
              'projectId',
              'agentName',
              'status',
              'config',
              'provider',
              'baseUrl',
            ].includes(key),
          );
        const isMembershipQuery = fieldKeys.includes('accountRole');

        const rowsFor = (): any[] => {
          if (isProjectSessionQuery) return [{ createdBy: TEST_USER_ID }];
          if (isDeadlineProbe) {
            return mockSandboxRows().length === 0
              ? []
              : [{ deadlineAt: new Date(Date.now() + 60 * 60_000) }];
          }
          if (isSandboxQuery) return mockSandboxRows();
          if (isMembershipQuery) return mockDbMembership ? [mockDbMembership] : [];
          // Fallback: empty (unknown query, e.g. accountGroupMembers in
          // resolveShareSubject — the test models no group memberships).
          return [];
        };
        return {
          from: (table: any) => {
            const afterFrom: Record<string, unknown> = {
              // loadSandbox joins project_sessions for the session's own agent.
              leftJoin: () => afterFrom,
              // `.where(...)` is both awaitable (resolveShareSubject awaits it
              // directly, expecting an array) and chainable via `.limit(n)`.
              where: () => {
                const query = {
                  orderBy: () => query,
                  limit: (n: number) => Promise.resolve(rowsFor().slice(0, n)),
                  then: (resolve: (rows: any[]) => unknown, reject?: (reason: unknown) => unknown) =>
                    Promise.resolve(rowsFor()).then(resolve, reject),
                };
                return query;
              },
            };
            return afterFrom;
          },
        };
      },
      update: (table: unknown) => ({
        set: (updates: Record<string, unknown>) => ({
          where: async () => {
            mockDbUpdateCalls.push({ table, updates });
          },
        }),
      }),
    },
  };
});

const realTurnLifecycle = await import('../projects/sandbox-turn-lifecycle');
mock.module('../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async () => 'granted',
  acceptSandboxTurn: async () => true,
  abandonSandboxTurn: async () => true,
}));

// IAM — a prompt that switches to a CONCRETE agent is authorized for
// `project.agent.read` on that agent before the re-mint (sandbox-proxy/routes/preview.ts).
// The real engine issues an `innerJoin` this file's `db` stub does not build, so
// leaving it unmocked makes `authorize` throw, the forward retry 4x, and every
// agent-switch assertion answer 502 instead of the 204 it is about.
//
// This file's subject is proxy FORWARDING, so the gate is held open here and the
// gate itself — 403-before-re-mint, the requested agent as the resource, the
// non-binding 'default' sentinel, and the no-round-trip ordinary turn — is pinned
// in sandbox-proxy/routes/preview-agent-authz.test.ts.
// preview.ts imports `authorize` from the barrel and `actorForUser` from
// `iam/actor` (both pure here — `actorForUser` builds an Actor with no DB read),
// so only the engine needs stubbing.
mock.module('../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_AGENT_READ: 'project.agent.read' },
  authorize: async () => ({ allowed: true, reason: 'role' }),
}));

mock.module('../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  // Mirrors the REAL narrowing (connector/share.ts): a session-bound caller — a
  // sandbox token — may reach only its OWN session. Without this the mock
  // ignored callerSessionId entirely, so a test could pass one and prove
  // nothing; the WebSocket leg's isolation had no coverage at all.
  canAccessSandboxSession: async ({
    userId,
    sessionId,
    callerSessionId,
  }: { userId?: string; sessionId?: string; callerSessionId?: string | null }) => {
    if (!(userId && mockDbSandbox && mockDbMembership)) return false;
    if (callerSessionId != null && callerSessionId !== sessionId) return false;
    return true;
  },
  canAccessPreviewSandbox: async ({ userId }: { userId?: string }) =>
    Boolean(userId && mockDbSandbox && mockDbMembership),
  resolvePreviewUserContext: async (sandboxId: string, userId?: string) =>
    userId && mockDbSandbox && mockDbMembership
      ? {
          userId,
          sandboxId: mockSandboxRows()[0]?.sandboxId ?? sandboxId,
          sandboxRole: 'member',
          scopes: ['*'],
        }
      : null,
  // combinedAuth is bypassed in this suite (see above), so no project-scoped
  // PAT ever reaches this — stub so the real module's shape stays satisfied
  // for anything that imports it.
  resolveSandboxProjectId: async () => null,
}));

// The path-form WebSocket upgrade authenticates its `?token=`. One token is
// valid here; the validators themselves are covered by the preview-auth suites.
const realPreviewAuth = await import('../sandbox-proxy/preview-auth');
mock.module('../sandbox-proxy/preview-auth', () => ({
  ...realPreviewAuth,
  authenticatePreviewPrincipalDetailed: async (token: string | null | undefined) =>
    token === 'ws-token' ? { userId: TEST_USER_ID, sessionId: null } : null,
}));

// Daytona SDK mock
mock.module('../shared/daytona', () => ({
  isDaytonaConfigured: () => true,
  archiveDaytonaSandboxById: async () => ({ ok: true }),
  isDaytonaDiskQuotaError: () => false,
  listStoppedDaytonaSandboxesOldestFirst: async function* () {},
  listDaytonaSnapshots: async () => [],
  deleteDaytonaSnapshotById: async () => true,
  getDaytona: () => ({
    get: async (sandboxId: string) => {
      return {
        getPreviewLink: async (port: number) => {
          return { url: mockPreviewUrl, token: mockPreviewToken };
        },
        start: async () => {
          mockWakeCalls.push(sandboxId);
        },
      };
    },
  }),
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../platform/providers', () => ({
  ...realProviders,
  // Whole-module replacement: every export the graph touches must be present or
  // the file loads to 0 tests (see the secrets mock above).
  SandboxTemplateNotFoundError: class SandboxTemplateNotFoundError extends Error {},
  providerAutoStopBackstopMinutes: () => 0,
  WarmRuntimeUnavailableError: class WarmRuntimeUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WarmRuntimeUnavailableError';
    }
  },
  getProvider: (name: string) => {
    const routeIngress = (request: { port: number; path?: string; transport?: string }) => {
      const ptyWebsocket =
        name === 'platinum' &&
        request.transport === 'websocket' &&
        classifyPtyWebSocketPath(request.path) !== null;
      return {
        effectivePort:
          name === 'platinum' && (request.port === 4096 || ptyWebsocket) ? 8000 : request.port,
        websocket: ptyWebsocket
          ? {
              userContextQueryParam: '__kortix_user_context',
              queryDefaults: { cursor: '0' },
            }
          : undefined,
      };
    };
    return {
      routeIngress,
      resolveIngress: async (
        _externalId: string,
        request: { port: number; path?: string; transport?: string },
      ) => {
        if (mockResolveIngressError) throw mockResolveIngressError;
        const route = routeIngress(request);
        mockResolvedPreviewPorts.push(route.effectivePort);
        return {
          url: mockPreviewUrl,
          headers:
            name === 'daytona'
              ? {
                  'X-Daytona-Skip-Preview-Warning': 'true',
                  'X-Daytona-Disable-CORS': 'true',
                  ...(mockPreviewToken ? { 'X-Daytona-Preview-Token': mockPreviewToken } : {}),
                }
              : name === 'e2b' && mockPreviewToken
                ? { 'e2b-traffic-access-token': mockPreviewToken }
                : {},
          effectivePort: route.effectivePort,
          websocket: route.websocket,
        };
      },
      ensureRunning: async (sandboxId: string) => {
        mockWakeCalls.push(sandboxId);
      },
    };
  },
}));

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test-version',
  config: {
    isDaytonaEnabled: () => true,
    // The preview CORS allowlist reads this. Set to the SAME value as the real
    // config default, because this file's collaborators resolve a mix of the
    // mocked and the real module — a disagreement here reads as a CORS bug.
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

mock.module('../projects/secrets', () => {
  const snapshot = (projectId: string) => ({
    env: {
      OPENROUTER_API_KEY: 'sk-live',
      SENTRY_DSN: 'https://example.test/1',
    },
    names: ['OPENROUTER_API_KEY', 'SENTRY_DSN'],
    revision: `rev-${projectId}`,
  });
  // mock.module REPLACES the module wholesale — an export omitted here is a
  // SyntaxError for anything else in the graph that imports it, which takes the
  // WHOLE FILE to 0 tests rather than failing one case. Stub the rest, and make
  // them throw so a real dependency is loud instead of silently undefined.
  return {
    AmbiguousSecretGrantError: class AmbiguousSecretGrantError extends Error {},
    resolveGrantedSecretEnv: () => ({}),
    isValidSecretName: () => true,
    intersectSecretGrants: (grant: unknown, allowlist: unknown) =>
      allowlist == null ? grant : allowlist,
    parseSessionSecretsAllowlist: () => null,
    secretKeyCollisionInAllowlist: () => null,
    canonicalizeSecretsAllowlist: (v: unknown) => v,
    secretsAllowlistPayloadConflicts: () => false,
    isValidIdentifier: () => true,
    identifierKeyConflicts: () => false,
    encryptProjectSecret: (_projectId: string, value: string) => value,
    decryptProjectSecret: (_projectId: string, value: string) => value,
    writeSharedProjectSecret: async () => ({}),
    listResolvedProjectSecrets: async () => [],
    listProjectSecrets: async (projectId: string) => snapshot(projectId).env,
    listProjectSecretsForUser: async (projectId: string) => snapshot(projectId).env,
    listProjectSecretsSnapshot: async (projectId: string) => snapshot(projectId),
    listProjectSecretNamesForConsumer: async () => [],
    listProjectSecretsSnapshotForUser: async (projectId: string) => snapshot(projectId),
    materializeSecretDelivery: async () => undefined,
    projectSecretIsConfiguredForConsumer: async () => false,
    projectSecretsRevision: (env: Record<string, string>) =>
      `rev-${Object.keys(env).sort().join('-')}`,
    getProjectSecretValue: async () => null,
    getProjectSecretValueForConsumer: async () => null,
    resolveProjectSecretForConsumer: async () => null,
    resolveProjectSecretsForConsumer: async () => ({}),
    withholdUndeliverable: () => undefined,
  };
});

mock.module('../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: (input: Record<string, unknown>) => {
    mockSnapshotSyncCalls.push(input);
  },
}));

// The proxy owns two of the four title hooks. Keep the REAL prompt extraction
// (that is the part the proxy actually decides) and capture only the generator
// call, whose own idempotency/CAS is covered by unit + integration tests.
let mockTitleCalls: Array<Record<string, unknown>> = [];
const realTitleGenerate = await import('../projects/session-title-generate');
mock.module('../projects/session-title-generate', () => ({
  ...realTitleGenerate,
  generateSessionTitleFromFirstPrompt: async (input: Record<string, unknown>) => {
    mockTitleCalls.push(input);
  },
}));

// Override global fetch for proxy requests
const originalFetch = globalThis.fetch;
function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

  // Let non-proxy URLs through (e.g. internal Hono test requests)
  if (
    !urlStr.startsWith('https://preview.') &&
    !urlStr.startsWith('http://preview.') &&
    !urlStr.includes('.e2b.test')
  ) {
    return originalFetch(url, init);
  }

  const responseConfig =
    mockFetchResponses[mockFetchCallCount] || mockFetchResponses[mockFetchResponses.length - 1];
  mockFetchCallCount++;

  mockFetchCalls.push({
    url: urlStr,
    method: (init?.method || 'GET').toUpperCase(),
    headers: Object.fromEntries(new Headers(init?.headers as any).entries()),
    body:
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : null,
    signal: init?.signal ?? null,
  });

  if (!responseConfig) {
    return Promise.resolve(new Response('OK', { status: 200 }));
  }

  if (responseConfig.error) {
    return Promise.reject(responseConfig.error);
  }

  return Promise.resolve(
    new Response(responseConfig.body, {
      status: responseConfig.status,
      headers: responseConfig.headers || {},
    }),
  );
}

// ─── Import proxy app AFTER mocks ────────────────────────────────────────────

const { sandboxProxyApp } = await import('../sandbox-proxy/index');
const { verifyKortixUserContext, KORTIX_USER_CONTEXT_HEADER } = await import(
  '../shared/kortix-user-context'
);
const { resolvePreviewWsUpstream } = await import('../sandbox-proxy/routes/preview');
const { invalidateSandbox } = await import('../sandbox-proxy/backend');
const { preparePreviewWsUpgrade } = await import('../sandbox-proxy/ws-proxy');
const { __resetPromptDedupe } = await import('../sandbox-proxy/prompt-dedupe');

// ─── Test app factory ────────────────────────────────────────────────────────

function createProxyTestApp() {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await runWithContext(
      c.req.method,
      c.req.path,
      async () => {
        await next();
      },
      c.req.header('traceparent'),
    );
  });

  app.route('/v1/p', sandboxProxyApp);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const response: Record<string, unknown> = {
        error: true,
        message: err.message,
        status: err.status,
      };
      if (err.status === 503) {
        c.header('Retry-After', '10');
      }
      return c.json(response, err.status);
    }
    return c.json({ error: true, message: 'Internal server error', status: 500 }, 500);
  });

  app.notFound((c) => c.json({ error: true, message: 'Not found', status: 404 }, 404));

  return app;
}

// ─── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetPromptDedupe();
  invalidateSandbox(TEST_SANDBOX_ID);
  invalidateSandbox('platinum-oc-http');
  invalidateSandbox('daytona-oc-http');
  mockDbSandbox = {
    sandboxId: TEST_SESSION_SANDBOX_ID,
    sessionId: '22222222-2222-4222-8222-222222222222',
    projectId: TEST_PROJECT_ID,
    accountId: 'account-001',
    status: 'active',
    config: { serviceKey: TEST_SERVICE_KEY },
    provider: 'daytona',
    baseUrl: null,
  };
  mockDbMembership = { accountRole: 'member' };
  mockPreviewUrl = 'https://preview.daytona.io/proxy-url';
  mockPreviewToken = 'daytona-preview-token-123';
  mockWakeCalls = [];
  mockFetchResponses = [{ status: 200, body: 'Hello from upstream' }];
  mockFetchCallCount = 0;
  mockFetchCalls = [];
  mockDbUpdateCalls = [];
  mockResolvedPreviewPorts = [];
  mockResolveIngressError = null;
  mockSnapshotSyncCalls = [];
  mockTitleCalls = [];
  // The per-sandbox env-push memo (`PROMPT_ENV_PUSH_TTL_MS`) would otherwise
  // carry over from the previous test on the same TEST_SANDBOX_ID and skip the
  // env-sync fetch each case queues first.
  __resetPromptModelSignatureCacheForTests();

  // Install mock fetch
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Preview proxy: websocket upstream resolution', () => {
  // The proxy composes the upstream URL from whatever ingress the provider
  // resolves, applies the provider's query defaults, and, where the provider
  // asks for it, signs the user context into the URL as well as the header.
  test.each([
    {
      name: 'a Daytona opencode PTY',
      provider: 'daytona',
      previewUrl: 'https://preview.daytona.io/proxy-url',
      port: 4096,
      path: '/pty/pty_test/connect',
      expected: 'wss://preview.daytona.io/proxy-url/pty/pty_test/connect',
      signedInUrl: false,
    },
    {
      name: 'a Platinum opencode PTY',
      provider: 'platinum',
      previewUrl: 'https://8000-platinum.sbx.example',
      port: 4096,
      path: '/pty/pty_test/connect',
      expected: 'wss://8000-platinum.sbx.example/pty/pty_test/connect',
      signedInUrl: true,
    },
    {
      name: 'a Platinum Kortix-native PTY',
      provider: 'platinum',
      previewUrl: 'https://8000-platinum.sbx.example',
      port: 8000,
      path: '/kortix/pty/kpty_test/connect',
      expected: 'wss://8000-platinum.sbx.example/kortix/pty/kpty_test/connect',
      signedInUrl: true,
    },
  ])('$name: the upstream URL and its signed context', async (row) => {
    mockDbSandbox = { ...mockDbSandbox, provider: row.provider };
    mockPreviewUrl = row.previewUrl;
    if (row.provider === 'platinum') mockPreviewToken = null;

    const upstream = await resolvePreviewWsUpstream({
      sandboxId: TEST_SANDBOX_ID,
      upstreamPort: row.port,
      userId: TEST_USER_ID,
      remainingPath: row.path,
      queryString: '',
      callerSessionId: null,
      boundCredentialSessionId: null,
    });

    expect(upstream.ok).toBe(true);
    if (!upstream.ok) return;
    const url = new URL(upstream.url);
    expect(`${url.origin}${url.pathname}`).toBe(row.expected);
    const queryContext = url.searchParams.get('__kortix_user_context');
    if (row.signedInUrl) {
      expect(verifyKortixUserContext(queryContext!, TEST_SERVICE_KEY).ok).toBe(true);
      expect(upstream.headers[KORTIX_USER_CONTEXT_HEADER]).toBe(queryContext!);
      // The provider's query defaults ride along.
      if (row.port === 4096) expect(url.searchParams.get('cursor')).toBe('0');
    } else {
      expect(queryContext).toBeNull();
    }
  });

  test('a sandbox token may open the PTY of its OWN session', async () => {
    const upstream = await resolvePreviewWsUpstream({
      sandboxId: TEST_SANDBOX_ID,
      upstreamPort: 4096,
      userId: TEST_USER_ID,
      remainingPath: '/pty/pty_test/connect',
      queryString: '',
      // The sandbox's own session id — the legitimate case, which must keep
      // working or the narrowing has broken the product.
      callerSessionId: mockDbSandbox?.sessionId ?? null,
      boundCredentialSessionId: mockDbSandbox?.sessionId ?? null,
    });
    expect(upstream.ok).toBe(true);
  });

  test('a sandbox token may NOT open ANOTHER end-user’s PTY', async () => {
    // The KaaB isolation property, on the WebSocket leg. Every session a wrapper
    // creates shares one `created_by`, so ownership alone cannot separate
    // end-users — the per-session gate is what does, and until now all three
    // tests here passed `callerSessionId: null`, exercising only the unbound
    // path. The leg was wired and unproven.
    const upstream = await resolvePreviewWsUpstream({
      sandboxId: TEST_SANDBOX_ID,
      upstreamPort: 4096,
      userId: TEST_USER_ID,
      remainingPath: '/pty/pty_test/connect',
      queryString: '',
      callerSessionId: '99999999-9999-4999-8999-999999999999',
      boundCredentialSessionId: '99999999-9999-4999-8999-999999999999',
    });
    expect(upstream.ok).toBe(false);
    if (!upstream.ok) expect(upstream.status).toBe(403);
  });
});

// The upgrade entry point. The PTY asks the box which half of the opencode
// port pair is live: a verified config reload boots the replacement on the idle
// half and promotes it, and a hardcoded 4096 then dials a dead socket.
describe('Preview proxy: websocket upgrade (path form)', () => {
  const upgradeUrl = (sandboxId: string, port: number, path: string, query = '?token=ws-token') =>
    new URL(`http://api.test/v1/p/${sandboxId}/${port}${path}${query}`);
  const healthReads = () => mockFetchCalls.filter((call) => call.url.endsWith('/kortix/health'));

  test('an upgrade with no token is refused', async () => {
    const res = await preparePreviewWsUpgrade(
      upgradeUrl(TEST_SANDBOX_ID, 4096, '/pty/pty_1/connect', ''),
    );
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  test.each([
    ['reports the standby port', { status: 200, body: '{"opencode_port":4097}' }, 4097],
    ['reports a port outside the pair', { status: 200, body: '{"opencode_port":3000}' }, 4096],
    ['answers 500', { status: 500, body: 'boom' }, 4096],
    ['cannot be reached', { status: 0, body: '', error: new Error('ECONNREFUSED') }, 4096],
    ['is too old to report the field', { status: 200, body: '{"status":"ok"}' }, 4096],
  ])('an opencode PTY dials the live port: the daemon %s', async (_label, health, port) => {
    mockFetchResponses = [health];

    const res = await preparePreviewWsUpgrade(
      upgradeUrl(`ws-live-port-${port}-${health.status}`, 4096, '/pty/pty_1/connect'),
    );

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.ingress?.port).toBe(port);
    expect(healthReads()).toHaveLength(1);
    // Bounded, so a wedged box cannot hang the terminal.
    expect(healthReads()[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  // The value changes on exactly the event this exists for, so it is read on
  // every connect.
  test('the live port is read on every connect, never cached', async () => {
    mockFetchResponses = [{ status: 200, body: '{"opencode_port":4097}' }];
    await preparePreviewWsUpgrade(upgradeUrl('ws-live-port-uncached', 4096, '/pty/pty_1/connect'));
    await preparePreviewWsUpgrade(upgradeUrl('ws-live-port-uncached', 4096, '/pty/pty_1/connect'));
    expect(healthReads()).toHaveLength(2);
  });

  test('a Kortix-native PTY keeps the port the client addressed and asks nothing', async () => {
    const res = await preparePreviewWsUpgrade(
      upgradeUrl('ws-kortix-pty', 8000, '/kortix/pty/kpty_1/connect'),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.ingress?.port).toBe(8000);
    expect(healthReads()).toEqual([]);
  });

  test('our own credentials and wake signal never reach the upstream', async () => {
    mockFetchResponses = [{ status: 200, body: '{"opencode_port":4096}' }];
    const res = await preparePreviewWsUpgrade(
      upgradeUrl(
        'ws-query-strip',
        4096,
        '/pty/pty_1/connect',
        '?token=ws-token&public_share=kps_x&wake=1&cursor=5',
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const upstream = new URL(res.data.url);
    expect(upstream.searchParams.get('token')).toBeNull();
    expect(upstream.searchParams.get('public_share')).toBeNull();
    expect(upstream.searchParams.get('wake')).toBeNull();
    expect(upstream.searchParams.get('cursor')).toBe('5');
  });

  // Both sides of one contract in two packages: the daemon's health payload
  // must publish the field the lookup reads.
  test('the daemon health payload publishes opencode_port', async () => {
    const health = await Bun.file(
      new URL(
        '../../../kortix-sandbox-agent-server/src/harness/open-code/diagnostics.ts',
        import.meta.url,
      ).pathname,
    ).text();
    expect(health).toContain('opencode_port:');
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Preview proxy: port validation', () => {
  test.each([
    ['abc', 400],
    ['0', 400],
    ['65536', 400],
    ['1', 200],
    ['65535', 200],
  ])('port %s answers %p', async (port, status) => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${port}/path`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(status);
    if (status === 400) expect((await res.json()).message).toContain('Invalid port');
  });
});

describe('Preview proxy: ownership', () => {
  test('returns 404 when sandbox not found', async () => {
    mockDbSandbox = null;
    const app = createProxyTestApp();
    // Use unique sandbox ID to avoid cache hits from other tests
    const res = await app.request(`/v1/p/sandbox-not-found-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'sandbox not found' });
  });

  test('returns 403 when user has no membership', async () => {
    mockDbMembership = null;
    const app = createProxyTestApp();
    // Use unique sandbox ID to avoid cache hits
    const res = await app.request(`/v1/p/sandbox-no-member-002/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(403);
  });

  test.each(['provisioning', 'stopped', 'error'])(
    'returns 503 when sandbox status is %s',
    async (status) => {
      mockDbSandbox = { ...mockDbSandbox, status };
      const app = createProxyTestApp();
      const res = await app.request(`/v1/p/sandbox-not-ready-${status}/${TEST_PORT}/`, {
        headers: { Authorization: 'Bearer test' },
      });
      expect(res.status).toBe(503);
      // `hop: control_plane` — this answer came off our own row read, so a
      // client must not count it as evidence that the box is unreachable.
      expect(res.headers.get('X-Kortix-Proxy-Hop')).toBe('control_plane');
      expect(res.headers.get('X-Kortix-Upstream-Status')).toBeNull();
      const body = await res.json();
      expect(body).toEqual({
        error: `sandbox not ready (status: ${status})`,
        port: TEST_PORT,
        status: 503,
        hop: 'control_plane',
        upstream_status: null,
        // Stable machine code + retry flag: a readiness 503 is a pending
        // state a client re-polls, never a terminal error.
        code: 'sandbox_not_ready',
        retry: true,
      });
    },
  );

});

describe('Preview proxy: forwarding', () => {
  test('proxies GET request and returns upstream response', async () => {
    mockFetchResponses = [
      { status: 200, body: '<html>Hello</html>', headers: { 'content-type': 'text/html' } },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/api/v2/page`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('<html>Hello</html>');
    // The path after the sandbox/port prefix is forwarded as is.
    expect(mockFetchCalls[0]?.url).toBe('https://preview.daytona.io/proxy-url/api/v2/page');
  });

  test('proxies POST request with body', async () => {
    mockFetchResponses = [{ status: 201, body: '{"id":"created"}' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/api/data`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'test' }),
    });
    expect(res.status).toBe(201);
    expect(mockFetchCalls).toHaveLength(1);
    expect(mockFetchCalls[0]?.method).toBe('POST');
    expect(mockFetchCalls[0]?.body).toBe('{"name":"test"}');
  });

  // `kortix sessions connect` / `opencode attach` reach opencode's HTTP API on
  // 4096 through the proxy on either provider. Which effective port the
  // provider picks is the provider's rule (platinum-private-ingress.test.ts).
  test.each([
    ['platinum', 'platinum-oc-http'],
    ['daytona', 'daytona-oc-http'],
  ])('%s: opencode(4096) HTTP is forwarded to the resolved ingress', async (provider, sandbox) => {
    mockDbSandbox = { ...mockDbSandbox, provider };
    mockFetchResponses = [{ status: 200, body: '{"sessions":[]}' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${sandbox}/4096/session`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    expect(mockFetchCalls.map((call) => call.url)).toEqual([
      'https://preview.daytona.io/proxy-url/session',
    ]);
  });

  test('syncs latest project secrets before forwarding prompt_async', async () => {
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(
      `/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async?directory=%2Fworkspace`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
      },
    );

    expect(res.status).toBe(204);
    expect(mockFetchCalls).toHaveLength(2);
    expect(mockFetchCalls[0].url).toBe('https://preview.daytona.io/proxy-url/kortix/env');
    expect(mockFetchCalls[0].method).toBe('POST');
    expect(mockFetchCalls[0].headers['authorization']).toBe(`Bearer ${TEST_SERVICE_KEY}`);
    expect(mockFetchCalls[0].headers['content-type']).toBe('application/json');
    expect(mockFetchCalls[0].headers['x-daytona-preview-token']).toBe('daytona-preview-token-123');
    expect(JSON.parse(mockFetchCalls[0].body ?? '{}')).toEqual({
      env: {
        OPENROUTER_API_KEY: 'sk-live',
        SENTRY_DSN: 'https://example.test/1',
      },
      llmGatewayEnabled: false,
      names: ['OPENROUTER_API_KEY', 'SENTRY_DSN'],
      opencodeEnv: {},
      refreshModels: true,
      revision: 'rev-OPENROUTER_API_KEY-SENTRY_DSN',
    });
    expect(mockFetchCalls[1].url).toBe(
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async?directory=%2Fworkspace',
    );
  });

  test('titles from a REST prompt_async body, with the model the user picked for the turn', async () => {
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: 'set up the MS Graph connector' }],
        model: { providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' },
      }),
    });

    expect(res.status).toBe(204);
    expect(mockTitleCalls).toEqual([
      {
        sessionId: mockDbSandbox.sessionId,
        projectId: TEST_PROJECT_ID,
        accountId: mockDbSandbox.accountId,
        userId: TEST_USER_ID,
        firstPromptText: 'set up the MS Graph connector',
        modelHint: 'codex/gpt-5.6-sol',
      },
    ]);
  });

  test('does not title a prompt body that carries no text', async () => {
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'image', url: 'x' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockTitleCalls).toEqual([]);
  });

  test('strips legacy default agent before forwarding prompt_async to OpenCode', async () => {
    mockDbSandbox = { ...mockDbSandbox, agentName: 'default' };
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agent: 'default', parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(JSON.parse(mockFetchCalls[1].body ?? '{}')).toEqual({
      parts: [{ type: 'text', text: 'hi' }],
    });
  });

  // In-session agent switching is allowed, unconditionally — there is no flag
  // and no refusal. A concrete agent is forwarded untouched whatever the
  // session booted with; only the literal 'default' sentinel is stripped. A new
  // session is stored with the sentinel, and the client echoes back the
  // concrete name it resolved "the default" to (the reported "agent switch
  // requires a new session" false positive).
  test.each([
    ['the agent the session runs', 'reviewer', 'reviewer'],
    ['a different concrete agent', 'reviewer', 'researcher'],
    ['a concrete agent in a default session', 'default', 'kortix'],
  ])('prompt_async naming %s is forwarded untouched', async (_label, sessionAgent, requested) => {
    mockDbSandbox = { ...mockDbSandbox, agentName: sessionAgent };
    mockFetchResponses = [
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: requested, parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockFetchCalls.map((call) => call.url)).toEqual([
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async',
    ]);
    expect(JSON.parse(mockFetchCalls[1]?.body ?? '{}')).toEqual({
      agent: requested,
      parts: [{ type: 'text', text: 'hi' }],
    });
  });

  test('returns a clean proxy error when project env sync is rejected', async () => {
    mockFetchResponses = [{ status: 401, body: '{"error":"unauthorized"}' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('env sync failed: 401');
    expect(mockFetchCalls).toHaveLength(1);
    expect(mockFetchCalls[0].url).toBe('https://preview.daytona.io/proxy-url/kortix/env');
  });

  test('does not retry non-transient project env sync HTTP errors that mention network failures', async () => {
    mockFetchResponses = [
      { status: 500, body: '{"error":"connection refused to metadata store"}' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('env sync failed: 500');
    expect(mockWakeCalls).toEqual([]);
    expect(mockFetchCalls).toHaveLength(1);
    expect(mockFetchCalls[0].url).toBe('https://preview.daytona.io/proxy-url/kortix/env');
  });

  test('retries transient project env sync failures before forwarding prompt_async', async () => {
    mockFetchResponses = [
      { status: 502, body: 'Bad Gateway' },
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockWakeCalls).toEqual([TEST_SANDBOX_ID]);
    expect(mockFetchCalls.map((call) => call.url)).toEqual([
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async',
    ]);
  });

  test('retries fetch-level project env sync connection failures before forwarding prompt_async', async () => {
    mockFetchResponses = [
      {
        status: 0,
        body: '',
        error: new Error('Unable to connect. Is the computer able to access the url?'),
      },
      { status: 200, body: '{"ok":true,"changed":true,"revision":"rev"}' },
      { status: 204, body: '' },
    ];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/session/ses_123/prompt_async`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
    });

    expect(res.status).toBe(204);
    expect(mockWakeCalls).toEqual([TEST_SANDBOX_ID]);
    expect(mockFetchCalls.map((call) => call.url)).toEqual([
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/kortix/env',
      'https://preview.daytona.io/proxy-url/session/ses_123/prompt_async',
    ]);
  });

  test('strips hop, auth, trace, and forces identity compression for forwarded request', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: {
        Authorization: 'Bearer test',
        Host: 'myapp.com',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        'X-Request-Id': 'caller-controlled',
        'Accept-Encoding': 'gzip, br',
        'X-Custom': 'keep-me',
        // The daemon tells a direct platform call from a proxied one by this
        // header. A caller that could set it would open the daemon's gate.
        'X-Kortix-Service-Call': '1',
      },
    });
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].headers['x-kortix-service-call']).toBeUndefined();
    expect(mockFetchCalls[0].headers['host']).toBeUndefined();
    expect(mockFetchCalls[0].headers['authorization']).toBe(`Bearer ${TEST_SERVICE_KEY}`);
    expect(mockFetchCalls[0].headers['accept-encoding']).toBe('identity');
    expect(mockFetchCalls[0].headers['x-custom']).toBe('keep-me');
    expect(mockFetchCalls[0].headers['traceparent']).toMatch(
      /^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/,
    );
    expect(mockFetchCalls[0].headers['traceparent']).not.toBe(
      '00-11111111111111111111111111111111-2222222222222222-01',
    );
    expect(mockFetchCalls[0].headers['x-request-id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(mockFetchCalls[0].headers['x-request-id']).not.toBe('caller-controlled');
  });

  // Provider headers are forwarded verbatim, and none is invented: the proxy
  // has no provider-specific branch.
  test.each([
    {
      provider: 'daytona',
      previewUrl: 'https://preview.daytona.io/proxy-url',
      token: 'daytona-preview-token-123',
      present: {
        'x-daytona-skip-preview-warning': 'true',
        'x-daytona-disable-cors': 'true',
        'x-daytona-preview-token': 'daytona-preview-token-123',
      },
      absent: ['e2b-traffic-access-token'],
    },
    {
      provider: 'e2b',
      previewUrl: 'https://8080-e2b-sandbox.e2b.test',
      token: 'e2b-traffic-token',
      present: { 'e2b-traffic-access-token': 'e2b-traffic-token' },
      absent: ['x-daytona-preview-token'],
    },
  ])('$provider ingress headers are forwarded as the provider resolved them', async (row) => {
    mockDbSandbox = { ...mockDbSandbox, provider: row.provider };
    mockPreviewUrl = row.previewUrl;
    mockPreviewToken = row.token;
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();

    await app.request(`/v1/p/provider-headers-${row.provider}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    expect(mockFetchCalls[0]?.headers).toMatchObject(row.present);
    for (const name of row.absent) expect(mockFetchCalls[0]?.headers[name]).toBeUndefined();
  });

  test('forwards signed user context for session sandbox access', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/kortix/health`, {
      headers: { Authorization: 'Bearer test' },
    });

    const signedContext = mockFetchCalls[0].headers[KORTIX_USER_CONTEXT_HEADER.toLowerCase()];
    expect(signedContext).toBeTruthy();
    const verified = verifyKortixUserContext(signedContext, TEST_SERVICE_KEY);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.context).toMatchObject({
        userId: TEST_USER_ID,
        sandboxId: TEST_SESSION_SANDBOX_ID,
        sandboxRole: 'member',
        scopes: ['*'],
      });
    }
  });

  test('marks proxied session sandbox and owning session as active usage', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const sandboxId = 'touch-sandbox-001';
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${sandboxId}/${TEST_PORT}/kortix/health`, {
      headers: { Authorization: 'Bearer test' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(
      mockDbUpdateCalls.some(
        (call) => call.table === sessionSandboxes && call.updates.lastUsedAt instanceof Date,
      ),
    ).toBe(true);
    expect(
      mockDbUpdateCalls.some(
        (call) => call.table === projectSessions && call.updates.status === 'running',
      ),
    ).toBe(true);
  });

  test('creates trace headers when caller does not provide traceparent', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(mockFetchCalls[0].headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(mockFetchCalls[0].headers['x-request-id']).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });

  test('does not forward arbitrary caller cookies upstream', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: {
        Cookie: 'tracking=abc; __preview_session=secret; prefs=dark',
        Authorization: 'Bearer test',
      },
    });
    expect(mockFetchCalls[0].headers['cookie']).toBeUndefined();
  });

  test('strips token query param from upstream URL', async () => {
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/page?token=secret&other=keep`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(mockFetchCalls[0].url).toContain('other=keep');
    expect(mockFetchCalls[0].url).not.toContain('token=secret');
  });

});

describe('Preview proxy: provider credential recovery', () => {
  const providerRejection = JSON.stringify({
    statusCode: 401,
    code: 'UNAUTHORIZED',
    message: 'unauthorized: authentication failed: Invalid or expired token',
  });

  const providerRefusals: typeof mockFetchResponses = [
    { status: 401, body: providerRejection, headers: { 'content-type': 'application/json' } },
    { status: 307, body: '', headers: { location: 'https://api.auth.daytona.io/user_management/authorize?state=opaque' } },
  ];
  for (const rejected of providerRefusals) {
    test(`refreshes rejected Daytona ingress credentials after ${rejected.status}`, async () => {
      mockFetchResponses = [rejected, { status: 200, body: '[]' }];
      const response = await createProxyTestApp().request(`/v1/p/${TEST_SANDBOX_ID}/8000/kortix/pty`, {
        headers: { Authorization: 'Bearer test' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect(mockResolvedPreviewPorts).toEqual([8000, 8000]);
      expect(mockFetchCallCount).toBe(2);
      expect(mockWakeCalls).toEqual([]);
    });
  }

  test('stops after one credential refresh and does not expose provider login redirects', async () => {
    mockFetchResponses = Array.from({ length: 5 }, () => ({ status: 401, body: providerRejection }));
    const response = await createProxyTestApp().request(`/v1/p/${TEST_SANDBOX_ID}/8000/kortix/pty`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('sandbox_provider_auth_unavailable');
    expect(mockFetchCallCount).toBe(2);
  });

  test('invalidates provider credentials without replaying a PTY creation', async () => {
    mockFetchResponses = [{ status: 401, body: providerRejection }];
    const app = createProxyTestApp();
    const response = await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/kortix/pty`, {
      method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(503);
    expect(mockFetchCallCount).toBe(1);
    mockFetchResponses = [{ status: 200, body: '[]' }];
    await app.request(`/v1/p/${TEST_SANDBOX_ID}/8000/kortix/pty`, { headers: { Authorization: 'Bearer test' } });
    expect(mockResolvedPreviewPorts).toEqual([8000, 8000]);
  });

  test('preserves application OAuth redirects', async () => {
    mockFetchResponses = [{ status: 307, body: '', headers: { location: 'https://accounts.example.com/login' } }];
    const response = await createProxyTestApp().request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://accounts.example.com/login');
    expect(mockFetchCallCount).toBe(1);
  });
});

describe('Preview proxy: CORS', () => {
  test('sets CORS headers for the web app, and for nobody else', async () => {
    // A preview's credential is an ambient SameSite=None cookie, so echoing an
    // arbitrary Origin back with Allow-Credentials would let ANY site read a
    // signed-in user's preview. Only the configured frontend is answered.
    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const app = createProxyTestApp();
    const allowed = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test', Origin: 'http://localhost:3000' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const stranger = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test', Origin: 'https://evil.example' },
    });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
    expect(stranger.headers.get('access-control-allow-credentials')).toBeNull();

    mockFetchResponses = [{ status: 200, body: 'OK' }];
    const noOrigin = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(noOrigin.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('sets CORS headers on proxy-generated sandbox auth errors', async () => {
    mockFetchResponses = [{ status: 401, body: 'bad signed context' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/global/event`, {
      headers: { Authorization: 'Bearer test', Origin: 'http://localhost:3000' },
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'sandbox proxy authentication rejected' });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

});

// Daytona answers 400 with one of these bodies before it reaches the box at
// all: the box is stopped or archived. The proxy wakes it once and retries.
describe('Preview proxy: auto-wake on a sandbox-down 400', () => {
  test.each(['no IP address found for sandbox', 'failed to get runner info: 404 Not Found'])(
    'triggers wake and retries when upstream answers 400 "%s"',
    async (downBody) => {
      mockFetchResponses = [
        { status: 400, body: downBody },
        { status: 200, body: 'Sandbox is back!' },
      ];
      const app = createProxyTestApp();
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: any) => fn()) as any;
      try {
        const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/`, {
          headers: { Authorization: 'Bearer test' },
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('Sandbox is back!');
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }
      expect(mockWakeCalls).toEqual([TEST_SANDBOX_ID]);
    },
  );
});

describe('Preview proxy: non-sandbox-down 400', () => {
  test('passes through 400 that is NOT sandbox-down', async () => {
    mockFetchResponses = [{ status: 400, body: 'Bad request: invalid input' }];
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/${TEST_SANDBOX_ID}/${TEST_PORT}/api`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ bad: 'data' }),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe('Bad request: invalid input');
  });
});

describe('Preview proxy: retry exhaustion', () => {
  test('returns 502 when all retries fail with connection errors', async () => {
    // Simulate connection errors (fetch throws) for all attempts
    // To do this, make all fetch calls throw
    const savedFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = ((url: any) => {
      callCount++;
      return Promise.reject(new Error('Connection refused'));
    }) as any;

    const app = createProxyTestApp();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    const res = await app.request(`/v1/p/sandbox-retry-exhaust-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    expect(res.status).toBe(502);
    // Every attempt resolved an ingress address and then had its connection
    // refused, on an ordinary app port — so this is the user's own process, and
    // a probe must not read it as "the runtime is gone".
    expect(res.headers.get('X-Kortix-Proxy-Hop')).toBe('upstream_port');
    const body = await res.json();
    expect(body).toEqual({
      error: 'sandbox upstream unreachable',
      port: TEST_PORT,
      status: 502,
      hop: 'upstream_port',
      upstream_status: null,
    });
    // Should have made 4 attempts (0, 1, 2, 3)
    expect(callCount).toBe(4);
  });

  // Same failure, session-data port: now it IS the runtime, and the probe must
  // count it. The two cases differ ONLY by the port, which is the whole point of
  // the hop.
  test('the same connection failure on the daemon port is attributed to the daemon', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('Connection refused'))) as any;

    const app = createProxyTestApp();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    const res = await app.request('/v1/p/sandbox-retry-exhaust-daemon-001/8000/kortix/health', {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    expect(res.status).toBe(502);
    expect(res.headers.get('X-Kortix-Proxy-Hop')).toBe('daemon');
    expect(await res.json()).toMatchObject({ hop: 'daemon' });
  });

  test('returns last 400 when all retries get sandbox-down (HTTP 400 path)', async () => {
    // On the last attempt (attempt 3), the code does NOT retry the 400 —
    // it passes it through because attempt < MAX_RETRIES is false.
    // So with 4 sandbox-down 400s, we get 400 on the 4th attempt.
    mockFetchResponses = [
      { status: 400, body: 'no IP address found' },
      { status: 400, body: 'no IP address found' },
      { status: 400, body: 'no IP address found' },
      { status: 400, body: 'no IP address found' },
    ];
    const app = createProxyTestApp();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    const res = await app.request(`/v1/p/sandbox-retry-400-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;

    // On the 4th attempt, attempt=3, condition is attempt < MAX_RETRIES (3 < 3 = false)
    // So the 400 passes through to the "Got an HTTP response" section
    expect(res.status).toBe(400);
  });

  test('wake is triggered only once across retries', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('Connection refused'))) as any;

    const app = createProxyTestApp();
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;

    await app.request(`/v1/p/sandbox-retry-wake-001/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    // Wake should be called only once (not once per retry)
    expect(mockWakeCalls.length).toBe(1);
  });
});

// A blocking session turn (`POST /session/:id/message`) can legitimately run
// long (reasoning + tool calls) — the upstream never sends response headers
// until it's fully done. That must NOT be treated like a stalled connection:
// no wake, no resend of the (non-idempotent) message, and a distinct,
// honest signal instead of the generic "sandbox unreachable" 502. See
// preview-retry-budget.ts (proxyAttemptTimeoutMs) and forwardToSandbox's
// catch block in routes/preview.ts.
describe('Preview proxy: long-turn completion timeout', () => {
  test('a connect-timer abort on POST /session/:id/message returns 504 LONG_TURN_PROXY_TIMEOUT — no wake, no resend', async () => {
    const savedFetch = globalThis.fetch;
    const origSetTimeout = globalThis.setTimeout;
    let callCount = 0;

    // Simulate a healthy upstream that is still computing: fetch never
    // resolves on its own, only rejects once the connect-timer aborts it —
    // exactly what a real long reasoning/tool turn looks like from the
    // proxy's perspective (TCP alive, no bytes yet).
    globalThis.fetch = ((_url: any, init?: RequestInit) => {
      callCount++;
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        const abortWith = () =>
          reject((signal as any)?.reason ?? new DOMException('aborted', 'TimeoutError'));
        if (signal?.aborted) {
          abortWith();
          return;
        }
        signal?.addEventListener('abort', abortWith);
      });
    }) as any;
    // Fire the connect-timer (and any retry delay) synchronously instead of
    // waiting out the real ~49.5s budget.
    globalThis.setTimeout = ((fn: any) => {
      fn();
      return 0 as any;
    }) as any;

    const app = createProxyTestApp();
    const res = await app.request(
      `/v1/p/sandbox-long-turn-001/${TEST_PORT}/session/sess-1/message`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'do a long thing' }] }),
      },
    );

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    expect(res.status).toBe(504);
    // A retry must re-evaluate the upstream, never replay a cached verdict.
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.code).toBe('LONG_TURN_PROXY_TIMEOUT');
    // The answer names the way out: the async endpoint and its event stream.
    expect(body.error).toContain('prompt_async');
    // Exactly one attempt: the exempted class gets ~the whole budget on
    // attempt 0, and a timeout there must NOT resend the (non-idempotent)
    // message — resending would duplicate the user's turn.
    expect(callCount).toBe(1);
    // The sandbox is healthy and still working — waking it is both wrong
    // and wasted (an extra provider call to an already-running box).
    expect(mockWakeCalls.length).toBe(0);
  });

  // The daemon replies to `/file/import` only after the download, fsync and
  // rename, and it does not observe a client disconnect. A replay downloads the
  // same attachment a second time, and a wake is wasted on a healthy box.
  test('a connect-timer abort on POST /file/import is not replayed and does not wake', async () => {
    const savedFetch = globalThis.fetch;
    const origSetTimeout = globalThis.setTimeout;
    let callCount = 0;
    globalThis.fetch = ((_url: any, init?: RequestInit) => {
      callCount++;
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        const abortWith = () =>
          reject((signal as any)?.reason ?? new DOMException('aborted', 'TimeoutError'));
        if (signal?.aborted) {
          abortWith();
          return;
        }
        signal?.addEventListener('abort', abortWith);
      });
    }) as any;
    globalThis.setTimeout = ((fn: any) => {
      fn();
      return 0 as any;
    }) as any;

    const app = createProxyTestApp();
    // Only the daemon port serves `/file/import`; on another port it is the user's own route.
    const res = await app.request(`/v1/p/sandbox-file-import-001/8000/file/import`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ command_id: 'c', attachment_id: 'a', part_index: 0 }),
    });

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    expect(res.status).toBe(502);
    expect(res.headers.get('X-Kortix-Proxy-Hop')).toBe('daemon');
    expect(callCount).toBe(1);
    expect(mockWakeCalls.length).toBe(0);
  });

  test('an ordinary connect-timer abort (non-message path) still wakes + retries as before', async () => {
    const savedFetch = globalThis.fetch;
    const origSetTimeout = globalThis.setTimeout;
    let callCount = 0;
    globalThis.fetch = ((_url: any, init?: RequestInit) => {
      callCount++;
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        const abortWith = () =>
          reject((signal as any)?.reason ?? new DOMException('aborted', 'TimeoutError'));
        if (signal?.aborted) {
          abortWith();
          return;
        }
        signal?.addEventListener('abort', abortWith);
      });
    }) as any;
    globalThis.setTimeout = ((fn: any) => {
      fn();
      return 0 as any;
    }) as any;

    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/sandbox-long-turn-002/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test' },
    });

    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = savedFetch;

    // Unchanged prior behavior: a plain GET that never gets bytes is a real
    // stall, not a long-turn completion — full retry/wake path still applies.
    expect(res.status).toBe(502);
    expect(callCount).toBe(4);
    expect(mockWakeCalls.length).toBe(1);
  });
});

describe('Preview proxy: no-trailing-slash', () => {
  test('/:sandboxId/:port without a trailing slash is proxied like the root', async () => {
    const app = createProxyTestApp();
    const res = await app.request(`/v1/p/sandbox-redirect-001/${TEST_PORT}`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    expect(mockFetchCalls[0]?.url).toBe('https://preview.daytona.io/proxy-url/');
  });
});

// A browser's /global/event stream that answers 200 and then never writes a
// byte is the signature of a stale cached ingress: no error status, so nothing
// invalidated it. The proxy counts the stream's bytes, and the next connect
// after a silent one re-resolves ingress instead of re-dialling the same dead
// address for the rest of the cache TTL.
describe('Preview proxy: SSE stall bypass', () => {
  async function connectAndDrain(sandbox: string): Promise<void> {
    const res = await createProxyTestApp().request(`/v1/p/${sandbox}/8000/global/event`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    await res.text();
  }

  test.each([
    ['a silent stream re-resolves ingress on the next connect', '', 2],
    ['a stream that delivered bytes keeps the cached ingress', 'data: {}\n\n', 1],
  ])('%s', async (_label, firstBody, resolutions) => {
    const sandbox = `sse-stall-${resolutions}`;
    mockFetchResponses = [
      { status: 200, body: firstBody, headers: { 'content-type': 'text/event-stream' } },
      { status: 200, body: 'data: {}\n\n', headers: { 'content-type': 'text/event-stream' } },
    ];
    await connectAndDrain(sandbox);
    await connectAndDrain(sandbox);
    expect(mockResolvedPreviewPorts).toHaveLength(resolutions);
  });
});

// The daemon's /kortix/opencode/* namespace negotiates compression with the
// client. `fetch` hands back DECODED bytes while keeping the upstream
// `content-encoding` and compressed `content-length`; forwarding those with a
// decoded body is a response no client can read.
describe('Preview proxy: upstream encoding on the daemon namespace', () => {
  test('the client negotiation reaches the daemon, and the decoded body is relabelled', async () => {
    mockFetchResponses = [
      {
        status: 200,
        body: '{"state":"ok"}',
        headers: { 'content-encoding': 'gzip', 'content-length': '12' },
      },
    ];
    const res = await createProxyTestApp().request(
      `/v1/p/${TEST_SANDBOX_ID}/8000/kortix/opencode/state`,
      { headers: { Authorization: 'Bearer test', 'Accept-Encoding': 'gzip' } },
    );

    expect(mockFetchCalls[0]?.headers['accept-encoding']).toBe('gzip');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('x-kortix-upstream-encoding')).toBe('gzip');
    expect(res.headers.get('access-control-expose-headers')).toContain('x-kortix-upstream-encoding');
  });
});

describe('Preview proxy: hop attribution when the provider never resolves', () => {
  test('an ingress that never resolved is the provider edge, not the box', async () => {
    mockResolveIngressError = new Error('provider API unavailable');
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: any) => fn()) as any;
    try {
      const res = await createProxyTestApp().request(`/v1/p/ingress-down-001/8000/kortix/health`, {
        headers: { Authorization: 'Bearer test' },
      });
      expect(res.status).toBe(502);
      expect(res.headers.get('X-Kortix-Proxy-Hop')).toBe('provider_ingress');
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(mockFetchCalls).toEqual([]);
  });
});

// A session-bound caller (a sandbox token) may reach only its OWN session's
// conversation. Every port that carries it is gated: the daemon (8000), both
// halves of opencode's port pair (4096/4097, reached directly on Daytona), and
// the static-file listener (3211), which reads that session's workspace.
// Ownership alone cannot separate end-users when every session of a wrapper
// shares one created_by.
describe('Preview proxy: per-session gate on session-data ports', () => {
  const FOREIGN_SESSION = '99999999-9999-4999-8999-999999999999';

  test.each([8000, 4096, 4097, 3211])(
    'another session\'s caller is refused on port %p',
    async (port) => {
      const res = await createProxyTestApp().request(`/v1/p/session-gate-${port}/${port}/`, {
        headers: { Authorization: 'Bearer test', 'X-Test-Caller-Session': FOREIGN_SESSION },
      });
      expect(res.status).toBe(403);
      expect(mockFetchCalls).toEqual([]);
    },
  );

  test('the session\'s own caller, and any caller on an ordinary app port, are forwarded', async () => {
    const app = createProxyTestApp();
    const own = await app.request(`/v1/p/session-gate-own/8000/kortix/health`, {
      headers: { Authorization: 'Bearer test', 'X-Test-Caller-Session': mockDbSandbox.sessionId },
    });
    expect(own.status).toBe(200);

    const appPort = await app.request(`/v1/p/session-gate-app/${TEST_PORT}/`, {
      headers: { Authorization: 'Bearer test', 'X-Test-Caller-Session': FOREIGN_SESSION },
    });
    expect(appPort.status).toBe(200);
  });
});
