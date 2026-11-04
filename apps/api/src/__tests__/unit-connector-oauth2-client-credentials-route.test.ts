/**
 * `PUT /projects/{projectId}/connectors/{slug}/oauth2/connection`: OAuth2
 * client credentials for a connector's shared account, as the CLI sends them.
 * Fake deps, no database.
 */
import { describe, expect, test } from 'bun:test';
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';

function app(seen: unknown[], outcome: () => Promise<unknown>) {
  return createConnectorRouter({
    featureFlagEnabled: async () => false,
    resolvePrincipal: async () => null,
    resolveProjectPrincipal: async () => null,
    makeGatewayDeps: (() => ({})) as unknown as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async (c) => (c.req.header('x-test-admin') ? { accountId: 'acct-1', userId: 'user-1' } : null),
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    setConnectorCredential: async (_p, slug, input) => {
      seen.push({ slug, input });
      return outcome() as never;
    },
  } as ConnectorRouterDeps);
}

const put = (a: ReturnType<typeof app>, body: unknown, admin = true) =>
  a.fetch(
    new Request('http://x/projects/p1/connectors/billing/oauth2/connection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(admin ? { 'x-test-admin': 'user-1' } : {}) },
      body: JSON.stringify(body),
    }),
  );

const BODY = { token_url: 'https://auth.example.test/oauth/token', client_id: 'abc', client_secret: 's3cret', scopes: ['read'], audience: 'https://api.example.test' };

describe('PUT …/connectors/{slug}/oauth2/connection', () => {
  test('stores the client credentials on the shared account and answers the account and the first token expiry', async () => {
    const seen: unknown[] = [];
    const res = await put(app(seen, async () => ({ ok: true, account: 'default', oauth2ExpiresAt: Date.UTC(2026, 9, 24, 12) })), BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: 'billing', account: 'default', expires_at: '2026-10-24T12:00:00.000Z' });
    expect(seen).toEqual([
      {
        slug: 'billing',
        input: { oauth2: { type: 'oauth2_client_credentials', token_endpoint_auth_method: 'client_secret_basic', ...BODY } },
      },
    ]);
  });

  test('a refused token request is 503 oauth2_token_failed; a bad body 400; no admin 403', async () => {
    const failed = await put(app([], async () => { throw new Error('OAuth2 token request failed (401): invalid_client'); }), BODY);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'oauth2_token_failed', code: 'oauth2_token_failed', detail: 'OAuth2 token request failed (401): invalid_client' });
    const seen: unknown[] = [];
    const bad = await put(app(seen, async () => ({ ok: true })), { token_url: 'http://insecure.test/token', client_id: 'abc', client_secret: 'x' });
    expect(bad.status).toBe(400);
    expect(seen).toEqual([]);
    expect((await put(app([], async () => ({ ok: true })), BODY, false)).status).toBe(403);
  });
});
