/**
 * Revocation must never 402. SCIM token revoke and SSO provider/mapping
 * delete are reduction-only actions (they can only shrink an account's
 * attack surface), so a lapsed or downgraded entitlement must never block
 * them — only role authorization should gate a DELETE here. Creation/update
 * of these same enterprise surfaces stays entitlement-gated.
 *
 * Every account in this suite is UNENTITLED (accountHasEntitlement always
 * false) so a 402 on a DELETE can only mean the gate wasn't actually removed.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

mock.module('../iam', () => ({
  ACCOUNT_ACTIONS: { ACCOUNT_READ: 'account.read', ACCOUNT_WRITE: 'account.write' },
  assertAuthorized: async () => {},
}));

mock.module('../shared/audit', () => ({
  recordAuditEvent: async () => {},
}));

mock.module('../billing/services/entitlements', () => ({
  accountHasEntitlement: async () => false,
}));

const scimTokenRow = {
  tokenId: 'tok-1',
  name: 'Okta',
  secret: 'kortix_scim_secret',
  publicPrefix: 'kortix_scim_ab…',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  expiresAt: null as Date | null,
};
mock.module('../repositories/scim', () => ({
  createScimToken: async () => scimTokenRow,
  listScimTokens: async () => [],
  revokeScimToken: async () => true,
}));

const ssoProviderRow = {
  ssoProviderId: 'sp-1',
  accountId: 'acct-1',
  supabaseSsoProviderId: '11111111-1111-1111-1111-111111111111',
  name: 'Entra',
  primaryDomain: 'example.com',
  groupClaimName: 'groups',
  autoCreateMembers: false,
  createdBy: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};
const ssoMappingRow = {
  mappingId: 'map-1',
  accountId: 'acct-1',
  ssoProviderId: 'sp-1',
  claimValue: 'Engineers',
  groupId: 'grp-1',
  groupName: 'Engineers',
  createdBy: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};
mock.module('../repositories/sso', () => ({
  getSsoProvider: async () => ssoProviderRow,
  upsertSsoProvider: async () => ssoProviderRow,
  deleteSsoProvider: async () => true,
  listSsoGroupMappings: async () => [],
  createSsoGroupMapping: async () => ssoMappingRow,
  deleteSsoGroupMapping: async () => true,
}));

const { iamRouter } = await import('../accounts/iam/app');
await import('../accounts/iam/scim-tokens');
await import('../accounts/iam/sso');

function buildApp() {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('userId', 'admin-1');
    await next();
  });
  app.route('/', iamRouter);
  return app;
}

const ACCOUNT = 'acct-1';

describe('SCIM tokens — DELETE bypasses the entitlement gate, POST keeps it', () => {
  test('DELETE /scim/tokens/:tokenId succeeds on an unentitled account', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/scim/tokens/tok-1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
  });

  test('POST /scim/tokens still 402s on an unentitled account', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/scim/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New token' }),
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe('entitlement_required');
  });
});

describe('SSO — DELETE routes bypass the entitlement gate, PUT/POST keep it', () => {
  test('DELETE /sso/provider succeeds on an unentitled account', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/sso/provider`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  test('DELETE /sso/mappings/:mappingId succeeds on an unentitled account', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/sso/mappings/map-1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  test('PUT /sso/provider still 402s on an unentitled account', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/sso/provider`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supabase_sso_provider_id: '11111111-1111-1111-1111-111111111111',
        name: 'Entra',
        primary_domain: 'example.com',
      }),
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe('entitlement_required');
  });

  test('POST /sso/mappings still 402s on an unentitled account', async () => {
    const res = await buildApp().request(`/${ACCOUNT}/iam/sso/mappings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim_value: 'Engineers', group_id: 'grp-1' }),
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe('entitlement_required');
  });
});
