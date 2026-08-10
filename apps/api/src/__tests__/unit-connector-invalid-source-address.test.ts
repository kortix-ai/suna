import { describe, expect, test } from 'bun:test';

/**
 * Regression for Better Stack API prod pattern `f5c0ce61…` —
 * `Error: Only https registry URLs on public hosts are allowed.`
 * (mechanism `generic`, `handled:true`), call site `assertAllowedSourceAddress`
 * in `apps/api/src/marketplace/catalog.ts`, on
 * `POST /v1/connectors/projects/:id/connectors` (8 occurrences, last 2026-08-04).
 *
 * Root cause: `assertAllowedSourceAddress` (the marketplace LFI/SSRF guard)
 * throws a bare `Error` when a user submits a non-https or non-public URL as a
 * connector source. The throw is a VALID security validation, NOT a server
 * defect — but the connector `POST /connectors` route handler called
 * `deps.discoverConnectorAuth(workspaceId, body)` (which invokes
 * `discoverConnectorAuthFromSource` → `assertAllowedSourceAddress`) with NO
 * try/catch, so the throw propagated uncaught through the connector sync path
 * → `app.onError` → generic `captureException` → Sentry → Better Stack.
 *
 * This is the SAME antipattern as PR #5240 (bare 501 "not supported" → typed
 * `feature_not_supported` envelope + SDK classification) and #5652
 * (`RepoFileNotFoundError` typed throw + route catch): an EXPECTED user-input
 * validation state must NOT page like a server defect.
 *
 * The fix:
 *  1. `assertAllowedSourceAddress` now throws a TYPED
 *     `AllowedSourceValidationError` (stable `code: 'invalid_source_address'`),
 *     exported from `marketplace/catalog.ts` (mirrors `RepoFileNotFoundError`).
 *  2. The `POST /connectors` + `POST /connectors/auth-discovery` route handlers
 *     catch the typed error and return a STRUCTURED 400
 *     `{ error: 'invalid_source_address', code, message }` instead of letting
 *     it propagate to `app.onError`/Sentry.
 *  3. `invalid_source_address` is in `SENTRY_IGNORE_ERRORS` (defense in depth).
 *
 * These tests drive the REAL connector router with a `discoverConnectorAuth`
 * dep that throws the typed `AllowedSourceValidationError` (the exact prod
 * failure shape), and assert:
 *   - the route returns 400 (NOT 500),
 *   - the body is the structured `invalid_source_address` envelope,
 *   - a NON-validation error (a genuine server failure) still propagates
 *     (re-thrown) so the generic `app.onError` + Sentry path stays loud.
 */
import {
  AllowedSourceValidationError,
  assertAllowedSourceAddress,
  isAllowedSourceValidationError,
} from '../marketplace/catalog';
import {
  createConnectorRouter,
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
} from '../connectors/router';

const WORKSPACE = 'proj-1';
const ALICE = 'user-alice';

/** The exact prod failure shape: `assertAllowedSourceAddress` throws the typed
 *  error for a non-https URL. Pin the typed contract first so the route
 *  handler's `isAllowedSourceValidationError` branch stays anchored on the
 *  real class. */
describe('assertAllowedSourceAddress throws a typed AllowedSourceValidationError', () => {
  test('non-https URL (the BS f5c0ce61 message)', () => {
    let caught: unknown;
    try {
      assertAllowedSourceAddress('http://example.com/registry.json');
    } catch (err) {
      caught = err;
    }
    expect(isAllowedSourceValidationError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(AllowedSourceValidationError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as AllowedSourceValidationError).code).toBe(
      'invalid_source_address',
    );
    expect((caught as AllowedSourceValidationError).message).toBe(
      'Only https registry URLs on public hosts are allowed.',
    );
    expect((caught as AllowedSourceValidationError).name).toBe(
      'AllowedSourceValidationError',
    );
  });

  test('local-folder source (LFI guard)', () => {
    expect(() => assertAllowedSourceAddress('./local-folder')).toThrow(
      AllowedSourceValidationError,
    );
    let caught: unknown;
    try {
      assertAllowedSourceAddress('/etc');
    } catch (err) {
      caught = err;
    }
    expect(isAllowedSourceValidationError(caught)).toBe(true);
    expect((caught as AllowedSourceValidationError).code).toBe(
      'invalid_source_address',
    );
  });

  test('private host (SSRF guard)', () => {
    expect(() =>
      assertAllowedSourceAddress('http://169.254.169.254/latest/meta-data'),
    ).toThrow(AllowedSourceValidationError);
    expect(() =>
      assertAllowedSourceAddress('https://192.168.1.10/registry.json'),
    ).toThrow(AllowedSourceValidationError);
  });

  test('unparseable address', () => {
    let caught: unknown;
    try {
      assertAllowedSourceAddress(':::not-a-url:::');
    } catch (err) {
      caught = err;
    }
    expect(isAllowedSourceValidationError(caught)).toBe(true);
  });

  test('allowed sources do NOT throw', () => {
    expect(() => assertAllowedSourceAddress('anthropics/skills')).not.toThrow();
    expect(() =>
      assertAllowedSourceAddress('https://example.com/registry.json'),
    ).not.toThrow();
  });

  test('isAllowedSourceValidationError narrows (negative cases)', () => {
    expect(isAllowedSourceValidationError(new Error('x'))).toBe(false);
    expect(isAllowedSourceValidationError(null)).toBe(false);
    expect(isAllowedSourceValidationError(undefined)).toBe(false);
    expect(isAllowedSourceValidationError('x')).toBe(false);
  });
});

// ── Route-level regression: the typed throw becomes a 400, not a 500 ────────

/** Build a connector router whose `discoverConnectorAuth` throws the EXACT prod
 *  failure shape (the typed `AllowedSourceValidationError`). The route handler
 *  must catch it and return a structured 400 — NOT let it reach `app.onError`. */
function buildRouter(throwFromCreate = false): {
  app: ReturnType<typeof createConnectorRouter>;
  createConnectorCalls: number;
} {
  let createConnectorCalls = 0;
  const deps: ConnectorRouterDeps = {
    featureFlagEnabled: async () => true,
    resolvePrincipal: async (c) => {
      const u = c.req.header('x-test-user');
      return u ? ({ accountId: 'acct-1', userId: u } as ConnectorPrincipal) : null;
    },
    resolveWorkspacePrincipal: async (_c, _projectId) => null,
    makeGatewayDeps: (() => ({} as unknown)) as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async (c) => {
      const u = c.req.header('x-test-admin');
      return u ? { accountId: 'acct-1', userId: u } : null;
    },
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    discoverConnectorAuth: async () => {
      // The exact prod failure shape: the auth-discovery path calls
      // assertAllowedSourceAddress on the draft endpoint, which throws the
      // typed validation error for a non-https / private / local source.
      throw new AllowedSourceValidationError(
        'Only https registry URLs on public hosts are allowed.',
      );
    },
    createConnector: async () => {
      createConnectorCalls += 1;
      if (throwFromCreate) {
        // The sync path (resolveCatalog / loadSourceText) ALSO calls
        // assertAllowedSourceAddress on re-materialize — same typed throw.
        throw new AllowedSourceValidationError(
          'Only https registry URLs on public hosts are allowed.',
        );
      }
      return { ok: true, sync: { synced: 1, errors: [] } };
    },
  };
  return { app: createConnectorRouter(deps), createConnectorCalls };
}

const admin = { 'x-test-admin': ALICE };

describe('connector router: assertAllowedSourceAddress throw → structured 400 (not 500)', () => {
  test('POST /connectors/auth-discovery returns a typed 400 invalid_source_address', async () => {
    const { app } = buildRouter();
    const req = (path: string, init: RequestInit = {}) =>
      app.fetch(new Request(`http://x${path}`, init));
    const res = await req(`/projects/${WORKSPACE}/connectors/auth-discovery`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'mcp', url: 'http://example.com/sse' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_source_address');
    expect(body.code).toBe('invalid_source_address');
    expect(body.message).toBe(
      'Only https registry URLs on public hosts are allowed.',
    );
  });

  test('POST /connectors (create) returns a typed 400 when discoverConnectorAuth throws', async () => {
    const { app, createConnectorCalls } = buildRouter();
    const req = (path: string, init: RequestInit = {}) =>
      app.fetch(new Request(`http://x${path}`, init));
    const res = await req(`/projects/${WORKSPACE}/connectors`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      // No explicit auth → the route calls discoverConnectorAuth first, which
      // throws the typed validation error. The route must catch it → 400,
      // NOT call createConnector, NOT 500.
      body: JSON.stringify({
        slug: 'private-api',
        provider: 'mcp',
        url: 'http://169.254.169.254/latest',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_source_address');
    expect(body.code).toBe('invalid_source_address');
    expect(body.message).toBe(
      'Only https registry URLs on public hosts are allowed.',
    );
    // createConnector must NOT be reached when discovery throws — the 400
    // short-circuits before the manifest write.
    expect(createConnectorCalls).toBe(0);
  });

  test('POST /connectors (create) returns a typed 400 when createConnector throws (sync path)', async () => {
    const { app } = buildRouter(true);
    const req = (path: string, init: RequestInit = {}) =>
      app.fetch(new Request(`http://x${path}`, init));
    const res = await req(`/projects/${WORKSPACE}/connectors`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      // Explicit auth → discoverConnectorAuth is skipped; createConnector
      // itself throws the typed validation error (the sync path's
      // resolveCatalog/loadSourceText calls assertAllowedSourceAddress).
      body: JSON.stringify({
        slug: 'private-api',
        provider: 'openapi',
        spec: 'http://192.168.1.5/openapi.json',
        auth: { type: 'none' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_source_address');
    expect(body.message).toBe(
      'Only https registry URLs on public hosts are allowed.',
    );
  });

  test('a NON-validation error still propagates (does NOT get swallowed as 400)', async () => {
    // A genuine server failure (not an AllowedSourceValidationError) must
    // still propagate to app.onError → captureException → Sentry — the catch
    // is narrow to the typed validation error, so unexpected failures stay
    // loud. Hono's default error handler converts the unhandled throw into a
    // 500 (in production the global app.onError does this + captureException).
    // The assertion: a non-validation error is NOT caught as a 400
    // invalid_source_address envelope — it surfaces as a 500 (the path the
    // production app.onError → captureException → Sentry would take).
    const deps: ConnectorRouterDeps = {
      featureFlagEnabled: async () => true,
      resolvePrincipal: async () => null,
      resolveWorkspacePrincipal: async () => null,
      makeGatewayDeps: (() => ({} as unknown)) as ConnectorRouterDeps['makeGatewayDeps'],
      listCatalog: async () => [],
      resolveAdmin: async (c) => {
        const u = c.req.header('x-test-admin');
        return u ? { accountId: 'acct-1', userId: u } : null;
      },
      listConnectors: async () => [],
      syncConnectors: async () => ({ synced: 0, errors: [] }),
      discoverConnectorAuth: async () => {
        // A genuine server failure — NOT an AllowedSourceValidationError.
        throw new Error('genuine upstream failure');
      },
      createConnector: async () => ({ ok: true, sync: { synced: 0, errors: [] } }),
    };
    const app = createConnectorRouter(deps);
    const res = await app.fetch(
      new Request(`http://x/projects/${WORKSPACE}/connectors/auth-discovery`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mcp', url: 'http://x' }),
      }),
    );
    // The genuine error must NOT be caught as a 400 invalid_source_address —
    // Hono's default error handler surfaces it as a 500 (the production
    // app.onError → captureException → Sentry path).
    expect(res.status).toBe(500);
    // The body is Hono's generic "Internal Server Error" text, NOT the typed
    // invalid_source_address validation envelope.
    const text = await res.text();
    expect(text).not.toContain('invalid_source_address');
  });
});
