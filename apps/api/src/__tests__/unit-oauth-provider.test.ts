// Sign in with Kortix: the token endpoint authenticates confidential clients by
// secret and public clients by PKCE alone, /revoke kills a token pair, the
// RFC 8414 document is served, and userinfo carries `sub`.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { oauthAccessTokens, oauthAuthorizationCodes, oauthClients, oauthRefreshTokens } from '@kortix/db';
import { createFakeDb, fakeUuid, type FakeDbLog } from './oauth-fake-db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const CONFIDENTIAL_ID = '00000000-0000-4000-a000-000000000201';
const PUBLIC_ID = '00000000-0000-4000-a000-000000000202';
const SECRET = 'kortix_ocs_correct';
const VERIFIER = 'verifier_' + 'x'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

// Real scrypt hashing needs API_KEY_SECRET (scripts/test.env provides it).
const { hashSecretKey } = await import('../shared/crypto');

const clients: Record<string, Record<string, unknown>> = {
  [CONFIDENTIAL_ID]: {
    clientId: CONFIDENTIAL_ID,
    name: 'Server App',
    clientType: 'confidential',
    clientSecretHash: hashSecretKey(SECRET),
    redirectUris: ['https://client.example/callback'],
    scopes: ['profile', 'kortix'],
    active: true,
  },
  [PUBLIC_ID]: {
    clientId: PUBLIC_ID,
    name: 'Browser App',
    clientType: 'public',
    clientSecretHash: hashSecretKey('unused'),
    redirectUris: ['https://spa.example/callback'],
    scopes: ['profile'],
    active: true,
  },
};

let requestedClientId = '';
let codes: Array<Record<string, unknown>> = [];
let accessTokens: Array<Record<string, unknown>> = [];
let refreshTokens: Array<Record<string, unknown>> = [];
let log: FakeDbLog;

const fake = createFakeDb({
  select: (table) => {
    if (table === oauthClients) return requestedClientId in clients ? [clients[requestedClientId]] : [];
    if (table === oauthAuthorizationCodes) return codes.filter((c) => c.clientId === requestedClientId);
    // The real queries filter by id / hash / revoked_at themselves; the fake
    // returns the table and the assertions read the rows back directly.
    if (table === oauthAccessTokens) return accessTokens;
    if (table === oauthRefreshTokens) return refreshTokens.filter((t) => !t.revokedAt);
    return [];
  },
  insert: (table, values) => {
    const row = { id: fakeUuid(), createdAt: new Date(), ...values };
    if (table === oauthAccessTokens) accessTokens.push(row);
    if (table === oauthRefreshTokens) refreshTokens.push(row);
    return row;
  },
  update: (table, set) => {
    if (table === oauthAuthorizationCodes) {
      const open = codes.find((c) => !c.usedAt);
      if (!open) return [];
      Object.assign(open, set);
      return [open];
    }
    if (table === oauthAccessTokens) {
      const rows = accessTokens.filter((t) => !t.revokedAt);
      rows.forEach((r) => Object.assign(r, set));
      return rows;
    }
    if (table === oauthRefreshTokens) {
      const rows = refreshTokens.filter((t) => !t.revokedAt);
      rows.forEach((r) => Object.assign(r, set));
      return rows;
    }
    return [];
  },
});
log = fake.log;

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    await next();
  },
}));
mock.module('../config', () => ({
  config: { FRONTEND_URL: 'https://app.example', KORTIX_URL: 'https://api.example', API_KEY_SECRET: process.env.API_KEY_SECRET },
}));
mock.module('../shared/db', () => ({ db: fake.db }));
mock.module('../shared/supabase', () => ({
  getSupabase: () => ({
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'oauth@example.test' } } }) } },
  }),
}));

const { oauthApp } = await import('../oauth');

function createApp() {
  const app = new Hono();
  app.route('/v1/oauth', oauthApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: (err as Error).message }, 500);
  });
  return app;
}

function form(fields: Record<string, string>) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

function seedCode(clientId: string, redirectUri: string, scopes: string[]) {
  const code = 'code_' + fakeUuid();
  codes.push({
    id: fakeUuid(),
    code,
    clientId,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    redirectUri,
    scopes,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
  return code;
}

describe('POST /v1/oauth/token', () => {
  beforeEach(() => {
    codes = [];
    accessTokens = [];
    refreshTokens = [];
    log.inserts.length = 0;
    log.updates.length = 0;
  });

  test('confidential client: secret + PKCE exchange mints a token pair whose hashes (not plaintext) are stored', async () => {
    requestedClientId = CONFIDENTIAL_ID;
    const code = seedCode(CONFIDENTIAL_ID, 'https://client.example/callback', ['profile', 'kortix']);
    const res = await createApp().request(
      '/v1/oauth/token',
      form({
        grant_type: 'authorization_code',
        client_id: CONFIDENTIAL_ID,
        client_secret: SECRET,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: VERIFIER,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^kortix_oat_/);
    expect(body.refresh_token).toMatch(/^kortix_ort_/);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'profile kortix' });
    expect(accessTokens[0]).toMatchObject({ userId: USER_ID, accountId: ACCOUNT_ID, clientId: CONFIDENTIAL_ID, scopes: ['profile', 'kortix'] });
    expect(accessTokens[0].tokenHash).not.toBe(body.access_token);
    expect(refreshTokens[0].tokenHash).not.toBe(body.refresh_token);
    expect(codes[0].usedAt).toBeInstanceOf(Date);
  });

  test('confidential client without a secret is invalid_client', async () => {
    requestedClientId = CONFIDENTIAL_ID;
    const code = seedCode(CONFIDENTIAL_ID, 'https://client.example/callback', ['profile']);
    const res = await createApp().request(
      '/v1/oauth/token',
      form({ grant_type: 'authorization_code', client_id: CONFIDENTIAL_ID, code, redirect_uri: 'https://client.example/callback', code_verifier: VERIFIER }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('invalid_client');
    expect(accessTokens).toHaveLength(0);
  });

  test('public client: PKCE alone mints tokens, and sending a secret is refused', async () => {
    requestedClientId = PUBLIC_ID;
    const code = seedCode(PUBLIC_ID, 'https://spa.example/callback', ['profile']);
    const ok = await createApp().request(
      '/v1/oauth/token',
      form({ grant_type: 'authorization_code', client_id: PUBLIC_ID, code, redirect_uri: 'https://spa.example/callback', code_verifier: VERIFIER }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).scope).toBe('profile');

    const code2 = seedCode(PUBLIC_ID, 'https://spa.example/callback', ['profile']);
    const refused = await createApp().request(
      '/v1/oauth/token',
      form({ grant_type: 'authorization_code', client_id: PUBLIC_ID, client_secret: 'anything', code: code2, redirect_uri: 'https://spa.example/callback', code_verifier: VERIFIER }),
    );
    expect(refused.status).toBe(401);
    expect((await refused.json()).error_description).toContain('public client');
  });

  test('a wrong code_verifier is invalid_grant and the code stays unused', async () => {
    requestedClientId = CONFIDENTIAL_ID;
    const code = seedCode(CONFIDENTIAL_ID, 'https://client.example/callback', ['profile']);
    const res = await createApp().request(
      '/v1/oauth/token',
      form({ grant_type: 'authorization_code', client_id: CONFIDENTIAL_ID, client_secret: SECRET, code, redirect_uri: 'https://client.example/callback', code_verifier: 'wrong' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toBe('PKCE verification failed');
    expect(codes[0].usedAt).toBeNull();
  });

  test('refresh_token rotates: old pair revoked, new pair issued with the same scopes', async () => {
    requestedClientId = CONFIDENTIAL_ID;
    const code = seedCode(CONFIDENTIAL_ID, 'https://client.example/callback', ['profile', 'kortix']);
    const first = await (
      await createApp().request(
        '/v1/oauth/token',
        form({ grant_type: 'authorization_code', client_id: CONFIDENTIAL_ID, client_secret: SECRET, code, redirect_uri: 'https://client.example/callback', code_verifier: VERIFIER }),
      )
    ).json();
    const res = await createApp().request(
      '/v1/oauth/token',
      form({ grant_type: 'refresh_token', client_id: CONFIDENTIAL_ID, client_secret: SECRET, refresh_token: first.refresh_token }),
    );
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.scope).toBe('profile kortix');
    expect(refreshTokens[0].revokedAt).toBeInstanceOf(Date);
    expect(accessTokens[0].revokedAt).toBeInstanceOf(Date);
    expect(accessTokens[1].revokedAt).toBeUndefined();
  });
});

describe('POST /v1/oauth/revoke', () => {
  beforeEach(() => {
    accessTokens = [{ id: 'at-1', tokenHash: 'h', clientId: CONFIDENTIAL_ID, userId: USER_ID, accountId: ACCOUNT_ID, scopes: ['profile'], expiresAt: new Date(Date.now() + 60_000) }];
    refreshTokens = [{ id: 'rt-1', tokenHash: 'h', accessTokenId: 'at-1', clientId: CONFIDENTIAL_ID, userId: USER_ID, accountId: ACCOUNT_ID, expiresAt: new Date(Date.now() + 60_000) }];
    requestedClientId = CONFIDENTIAL_ID;
  });

  test('revoking an access token revokes its refresh token too', async () => {
    const res = await createApp().request(
      '/v1/oauth/revoke',
      form({ client_id: CONFIDENTIAL_ID, client_secret: SECRET, token: 'kortix_oat_whatever' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(accessTokens[0].revokedAt).toBeInstanceOf(Date);
    expect(refreshTokens[0].revokedAt).toBeInstanceOf(Date);
  });

  test('an unauthenticated client cannot revoke', async () => {
    const res = await createApp().request(
      '/v1/oauth/revoke',
      form({ client_id: CONFIDENTIAL_ID, client_secret: 'wrong', token: 'kortix_oat_whatever' }),
    );
    expect(res.status).toBe(401);
    expect(accessTokens[0].revokedAt).toBeUndefined();
  });

  test('an unknown token still answers 200 revoked=false (RFC 7009 §2.2)', async () => {
    const res = await createApp().request(
      '/v1/oauth/revoke',
      form({ client_id: CONFIDENTIAL_ID, client_secret: SECRET, token: 'not-a-kortix-token' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
  });
});

describe('discovery + userinfo', () => {
  test('the RFC 8414 document names the configured issuer and every endpoint', async () => {
    const res = await createApp().request('/v1/oauth/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: 'https://api.example',
      authorization_endpoint: 'https://api.example/v1/oauth/authorize',
      token_endpoint: 'https://api.example/v1/oauth/token',
      revocation_endpoint: 'https://api.example/v1/oauth/revoke',
      userinfo_endpoint: 'https://api.example/v1/oauth/userinfo',
      scopes_supported: ['profile', 'email', 'kortix'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    });
  });

  test('userinfo returns sub + email for a profile-scoped token', async () => {
    accessTokens = [{ id: 'at-1', tokenHash: 'h', clientId: CONFIDENTIAL_ID, userId: USER_ID, accountId: ACCOUNT_ID, scopes: ['profile'], expiresAt: new Date(Date.now() + 60_000) }];
    const res = await createApp().request('/v1/oauth/userinfo', { headers: { Authorization: 'Bearer kortix_oat_x' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: USER_ID, user_id: USER_ID, account_id: ACCOUNT_ID, email: 'oauth@example.test' });
  });
});
