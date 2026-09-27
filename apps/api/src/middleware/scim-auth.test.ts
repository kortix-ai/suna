/**
 * The SCIM authenticator names the directory token in the request audit.
 *
 * `/scim/v2` creates and deactivates users and changes group membership. It
 * was never request-audited (the audit middleware covered `/v1/*` only), and
 * its explicit rows record `actor_user_id: null` with the token id buried in
 * metadata. The token is the actor: bind it the moment it is proven — before
 * the account and plan checks — so a refused token is named too.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { runWithContext } from '../lib/request-context';
import { attachInboundAuditScope } from '../shared/audit-scope';

const ACCOUNT = '00000000-0000-4000-a000-000000000101';
const OTHER = '00000000-0000-4000-a000-000000000102';
let entitled = true;

const realScim = await import('../repositories/scim');
mock.module('../repositories/scim', () => ({
  ...realScim,
  validateScimToken: async (token: string) =>
    token === 'scim-good'
      ? { ok: true, accountId: ACCOUNT, tokenId: 'scim-tok-1' }
      : { ok: false, reason: 'unknown' },
}));
const realEntitlements = await import('../billing/services/entitlements');
mock.module('../billing/services/entitlements', () => ({
  ...realEntitlements,
  accountHasEntitlement: async () => entitled,
}));

const { scimAuth } = await import('./scim-auth');

function app(): Hono {
  const hono = new Hono();
  hono.use('/scim/v2/:accountId/*', scimAuth);
  hono.post('/scim/v2/:accountId/Users', (c) => c.json({ id: 'u1' }, 201));
  return hono;
}

async function principalAfter(token: string, accountInUrl = ACCOUNT) {
  return runWithContext('POST', `/scim/v2/${accountInUrl}/Users`, async () => {
    const scope = attachInboundAuditScope({ owner: 'edge', method: 'POST' });
    const res = await app().request(`/scim/v2/${accountInUrl}/Users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: '{}',
    });
    return { status: res.status, principal: scope.principal };
  });
}

beforeEach(() => {
  entitled = true;
});

describe('scimAuth binds the directory token', () => {
  test('a valid token is the actor on its account', async () => {
    const { status, principal } = await principalAfter('scim-good');
    expect(status).toBe(201);
    expect(principal).toEqual({
      accountId: ACCOUNT,
      actorUserId: null,
      actorType: 'system',
      authoritativeSource: 'scim',
      authMethod: { kind: 'scim_token', token_id: 'scim-tok-1' },
    });
  });

  test('a token probing another account is refused and still named', async () => {
    const { status, principal } = await principalAfter('scim-good', OTHER);
    expect(status).toBe(403);
    expect(principal).toMatchObject({
      accountId: ACCOUNT,
      authMethod: { kind: 'scim_token', token_id: 'scim-tok-1' },
    });
  });

  test('a token refused by the plan gate is still named', async () => {
    entitled = false;
    const { status, principal } = await principalAfter('scim-good');
    expect(status).toBe(403);
    expect(principal).toMatchObject({ authoritativeSource: 'scim' });
  });

  test('an invalid token binds nothing', async () => {
    const { status, principal } = await principalAfter('scim-forged');
    expect(status).toBe(401);
    expect(principal).toEqual({});
  });
});
