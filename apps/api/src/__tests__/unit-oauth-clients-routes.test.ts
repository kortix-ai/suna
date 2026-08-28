// Sign in with Kortix: the self-serve OAuth client registry under
// /accounts/{id}/iam/oauth-clients — permission leaves, input validation, and
// the secret-shown-once contract.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realRepo from '../repositories/oauth-clients';

const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const USER_ID = '00000000-0000-4000-a000-000000000001';

let asserted: string[] = [];
let denyAll = false;
let store: Array<Record<string, unknown>> = [];
let audits: Array<Record<string, unknown>> = [];

mock.module('../iam', () => ({
  ACCOUNT_ACTIONS: { TOKEN_READ: 'token.read', TOKEN_CREATE: 'token.create', TOKEN_REVOKE: 'token.revoke', ACCOUNT_WRITE: 'account.write' },
  assertAuthorized: async (_actor: unknown, action: string) => {
    asserted.push(action);
    if (denyAll) throw new HTTPException(403, { message: `denied:${action}` });
  },
}));
mock.module('../iam/actor', () => ({ actorOf: async () => ({ userId: USER_ID, accountId: ACCOUNT_ID }) }));
mock.module('../accounts/iam/helpers', () => ({
  auditIam: async (_c: unknown, args: Record<string, unknown>) => {
    audits.push(args);
  },
  readBody: async (c: any) => c.req.json(),
  requireEntitlement: async () => null,
  isUniqueViolation: () => false,
  HttpError: class extends Error {},
}));

let nextSecret = 0;
mock.module('../repositories/oauth-clients', () => {
  const real = realRepo;
  const mk = (input: Record<string, unknown>) => ({
    clientId: `00000000-0000-4000-c000-${String(store.length + 1).padStart(12, '0')}`,
    accountId: ACCOUNT_ID,
    description: null,
    active: true,
    createdBy: USER_ID,
    createdAt: new Date('2026-08-26T00:00:00Z'),
    updatedAt: new Date('2026-08-26T00:00:00Z'),
    ...input,
  });
  return {
    ...real,
    listOAuthClients: async () => store,
    getOAuthClient: async (_a: string, id: string) => store.find((c) => c.clientId === id) ?? null,
    createOAuthClient: async (input: Record<string, unknown>) => {
      const row = mk(input);
      store.push(row);
      nextSecret += 1;
      return { ...row, clientSecret: input.clientType === 'confidential' ? `kortix_ocs_secret${nextSecret}` : null };
    },
    updateOAuthClient: async (_a: string, id: string, patch: Record<string, unknown>) => {
      const row = store.find((c) => c.clientId === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    rotateOAuthClientSecret: async (_a: string, id: string) => {
      const row = store.find((c) => c.clientId === id);
      if (!row) return null;
      if (row.clientType !== 'confidential') throw new real.OAuthClientInputError('a public client has no secret to rotate');
      nextSecret += 1;
      return { ...row, clientSecret: `kortix_ocs_secret${nextSecret}` };
    },
    deleteOAuthClient: async (_a: string, id: string) => {
      const before = store.length;
      store = store.filter((c) => c.clientId !== id);
      return store.length < before;
    },
  };
});

const { iamRouter } = await import('../accounts/iam/app');
await import('../accounts/iam/oauth-clients');

function createApp() {
  const app = new Hono();
  app.use('/*', async (c, next) => {
    c.set('userId' as never, USER_ID as never);
    await next();
  });
  app.route('/v1/accounts', iamRouter);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: (err as Error).message }, 500);
  });
  return app;
}

const jsonReq = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const base = `/v1/accounts/${ACCOUNT_ID}/iam/oauth-clients`;

describe('OAuth client registry routes', () => {
  beforeEach(() => {
    asserted = [];
    denyAll = false;
    store = [];
    audits = [];
    nextSecret = 0;
  });

  test('register a confidential client: secret returned once, never on list/get; audit written', async () => {
    const app = createApp();
    const created = await app.request(
      base,
      jsonReq('POST', { name: 'Dashboards', redirect_uris: ['https://dash.example/api/kortix/auth/callback'], scopes: ['profile', 'kortix'] }),
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.client_secret).toBe('kortix_ocs_secret1');
    expect(body).toMatchObject({ name: 'Dashboards', client_type: 'confidential', redirect_uris: ['https://dash.example/api/kortix/auth/callback'], scopes: ['profile', 'kortix'], active: true });
    expect(asserted).toEqual(['token.create']);
    expect(audits[0]).toMatchObject({ action: 'iam.oauth_client.create', resourceType: 'oauth_client', resourceId: body.client_id });

    const list = await app.request(base);
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.oauth_clients).toHaveLength(1);
    expect('client_secret' in listed.oauth_clients[0]).toBe(false);
    expect(listed.scopes_supported).toEqual(['profile', 'email', 'kortix']);

    const one = await app.request(`${base}/${body.client_id}`);
    expect('client_secret' in (await one.json())).toBe(false);
  });

  test('a public client gets no secret, defaults scopes, and cannot rotate', async () => {
    const app = createApp();
    const created = await app.request(base, jsonReq('POST', { name: 'SPA', client_type: 'public', redirect_uris: ['http://localhost:3200/cb'] }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.client_secret).toBeNull();
    expect(body.scopes).toEqual(['profile', 'email', 'kortix']);
    const rotate = await app.request(`${base}/${body.client_id}/rotate-secret`, jsonReq('POST'));
    expect(rotate.status).toBe(400);
    expect((await rotate.json()).error).toContain('public client');
  });

  test('input validation: non-loopback http redirect and unknown scope are 400', async () => {
    const app = createApp();
    const http = await app.request(base, jsonReq('POST', { name: 'x', redirect_uris: ['http://dash.example/cb'] }));
    expect(http.status).toBe(400);
    expect((await http.json()).error).toContain('https');
    const scope = await app.request(base, jsonReq('POST', { name: 'x', redirect_uris: ['https://dash.example/cb'], scopes: ['admin'] }));
    expect(scope.status).toBe(400);
    expect((await scope.json()).error).toContain('unknown scope');
    expect(store).toHaveLength(0);
  });

  test('rotate returns a fresh secret; patch + delete assert their leaves and audit', async () => {
    const app = createApp();
    const { client_id } = await (await app.request(base, jsonReq('POST', { name: 'x', redirect_uris: ['https://a.example/cb'] }))).json();
    asserted = [];
    const rotated = await app.request(`${base}/${client_id}/rotate-secret`, jsonReq('POST'));
    expect(rotated.status).toBe(200);
    expect((await rotated.json()).client_secret).toBe('kortix_ocs_secret2');

    const patched = await app.request(`${base}/${client_id}`, jsonReq('PATCH', { name: 'renamed', active: false }));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: 'renamed', active: false });

    const deleted = await app.request(`${base}/${client_id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(asserted).toEqual(['token.create', 'token.create', 'token.revoke']);
    expect(audits.map((a) => a.action)).toEqual([
      'iam.oauth_client.create',
      'iam.oauth_client.rotate_secret',
      'iam.oauth_client.update',
      'iam.oauth_client.delete',
    ]);
    expect(store).toHaveLength(0);
  });

  test('every route is behind the IAM leaf: a denied actor gets 403 and nothing is written', async () => {
    denyAll = true;
    const app = createApp();
    expect((await app.request(base)).status).toBe(403);
    expect((await app.request(base, jsonReq('POST', { name: 'x', redirect_uris: ['https://a.example/cb'] }))).status).toBe(403);
    expect(store).toHaveLength(0);
    expect(asserted).toEqual(['token.read', 'token.create']);
  });

  test('a malformed client id is a 404, not a database error', async () => {
    const app = createApp();
    expect((await app.request(`${base}/notreal`)).status).toBe(404);
    expect((await app.request(`${base}/notreal`, { method: 'DELETE' })).status).toBe(404);
  });
});
