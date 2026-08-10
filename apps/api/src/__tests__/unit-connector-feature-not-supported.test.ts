import { describe, expect, test } from 'bun:test';

/**
 * Regression for Better Stack pattern `1f3c4d96…` — `ApiError: not supported`
 * (HTTP 501) on the co-worker session "add connector" path
 * (`POST /v1/connectors/projects/:id/connectors/auth-discovery`).
 *
 * Root cause: at production release `470fe6f3c8` (v0.10.13) the
 * `discoverConnectorAuth` dep had been dropped from `dbConnectorRouterDeps`, so
 * the auth-discovery route hit its `if (!deps.discoverConnectorAuth) return
 * c.json({ error: 'not supported' }, 501)` guard. The bare string body surfaced
 * in Sentry as an opaque `ApiError` with a useless message — a known
 * "deployment doesn't offer this capability" state paging like a real defect.
 * (The dropped dep was restored in `aa78c3e43`; these tests pin the TYPED
 * response so the remaining antipattern — a bare `not supported` 501 — is
 * gone and the SDK can classify it out of Sentry.)
 *
 * These tests drive the REAL connector router with an admin resolver but NONE
 * of the optional connector capabilities wired, so every `!deps.X` guard
 * fires. They assert each returns a STRUCTURED 501 envelope
 * (`code: 'feature_not_supported'`, a human `message`, and a `feature` name)
 * instead of the legacy bare `{ error: 'not supported' }` string — the
 * contract the SDK's `makeRequest` relies on to drop the expected state from
 * Sentry while still returning an `ApiError` for the UI to branch on.
 */
import {
  createConnectorRouter,
  FEATURE_NOT_SUPPORTED_CODE,
  type ConnectorPrincipal,
  type ConnectorRouterDeps,
} from '../connectors/router';

const WORKSPACE = 'proj-1';
const ALICE = 'user-alice';

/** Minimal deps: an admin always resolves, but NO optional capability is
 *  wired — so every `!deps.X` guard in the admin routes fires. */
const deps: ConnectorRouterDeps = {
  featureFlagEnabled: async () => true,
  resolvePrincipal: async (c) => {
    const u = c.req.header('x-test-user');
    return u ? ({ accountId: 'acct-1', userId: u } as ConnectorPrincipal) : null;
  },
  resolveWorkspacePrincipal: async (c, workspaceId) => {
    const u = c.req.header('x-test-user');
    return u && workspaceId === WORKSPACE ? ({ accountId: 'acct-1', userId: u } as ConnectorPrincipal) : null;
  },
  makeGatewayDeps: (() => ({} as unknown)) as ConnectorRouterDeps['makeGatewayDeps'],
  listCatalog: async () => [],
  resolveAdmin: async (c) => {
    const u = c.req.header('x-test-admin');
    return u ? { accountId: 'acct-1', userId: u } : null;
  },
  listConnectors: async () => [],
  syncConnectors: async () => ({ synced: 0, errors: [] }),
  // NOTE: every optional capability (createConnector, discoverConnectorAuth,
  // deleteConnector, setConnectorCredential, …, pipedream*, projectPolicies*)
  // is deliberately OMITTED so the not-supported guards fire.
};

const app = createConnectorRouter(deps);
const req = (path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://x${path}`, init));

/** Admin header so the `resolveAdmin` gate passes and the request reaches the
 *  capability guard (otherwise it'd 403 before the not-supported branch). */
const admin = { 'x-test-admin': ALICE };

async function expectFeatureNotSupported(res: Response, feature: string) {
  expect(res.status).toBe(501);
  const body = await res.json();
  expect(body.code).toBe(FEATURE_NOT_SUPPORTED_CODE);
  expect(body.error).toBe(FEATURE_NOT_SUPPORTED_CODE);
  expect(typeof body.message).toBe('string');
  expect(body.message.length).toBeGreaterThan(0);
  // The legacy bare-string body (`{ error: 'not supported' }`) is GONE — a
  // sentinel caller/SDK that branched on the literal would now miss it, which
  // is exactly the point: the typed code is the stable contract.
  expect(body.error).not.toBe('not supported');
  expect(body.feature).toBe(feature);
}

describe('connector router: optional-capability 501 is a TYPED feature_not_supported envelope', () => {
  test('POST /connectors/auth-discovery (the BS 1f3c4d96 path)', async () => {
    const res = await req(`/projects/${WORKSPACE}/connectors/auth-discovery`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openapi', spec: 'https://example.com/openapi.json' }),
    });
    await expectFeatureNotSupported(res, 'connector_auth_discovery');
  });

  test('POST /connectors (create)', async () => {
    const res = await req(`/projects/${WORKSPACE}/connectors`, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'x', provider: 'openapi', spec: 'https://example.com/openapi.json' }),
    });
    await expectFeatureNotSupported(res, 'connector_create');
  });

  test('DELETE /connectors/:slug', async () => {
    const res = await req(`/projects/${WORKSPACE}/connectors/stripe`, {
      method: 'DELETE',
      headers: admin,
    });
    await expectFeatureNotSupported(res, 'connector_delete');
  });

  test('GET /pipedream/apps (pipedream not configured)', async () => {
    const res = await req(`/projects/${WORKSPACE}/pipedream/apps`, {
      headers: admin,
    });
    await expectFeatureNotSupported(res, 'pipedream_apps');
  });

  test('PUT /connectors/:slug/credential (set credential)', async () => {
    const res = await req(`/projects/${WORKSPACE}/connectors/stripe/credential`, {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'sk_live_x' }),
    });
    await expectFeatureNotSupported(res, 'connector_credential_set');
  });

  test('GET /projects/:id/policies (project policies read)', async () => {
    const res = await req(`/projects/${WORKSPACE}/policies`, {
      headers: admin,
    });
    await expectFeatureNotSupported(res, 'project_policies_read');
  });
});
