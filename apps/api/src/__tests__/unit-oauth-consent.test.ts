// Sign in with Kortix: the authorization request is persisted (not held in an
// in-process Map), the consent screen sees only an opaque request id, approval
// mints a code bound to the STORED request fields, remembers the consent, and
// a replayed decision is refused.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountMembers,
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthClients,
  oauthConsents,
} from '@kortix/db';
import { createFakeDb, fakeUuid, type FakeDbLog } from './oauth-fake-db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';
const CLIENT_ID = '00000000-0000-4000-a000-000000000201';

const CLIENT_ROW = {
  clientId: CLIENT_ID,
  name: 'Trusted Client',
  clientType: 'confidential',
  clientSecretHash: 'scrypt:v1:00',
  redirectUris: ['https://client.example/callback'],
  scopes: ['profile', 'kortix'],
  active: true,
};

// Stored pending requests, keyed by request_id_hash. The fake cannot evaluate
// the drizzle predicate, so the handler returns the single un-consumed row.
let pendingRequests: Array<Record<string, unknown>> = [];
let consents: Array<Record<string, unknown>> = [];
let log: FakeDbLog;

const fake = createFakeDb({
  select: (table) => {
    if (table === oauthClients) return [CLIENT_ROW];
    if (table === accountMembers) return [{ accountId: ACCOUNT_ID }];
    if (table === oauthAuthorizationRequests) return pendingRequests.filter((r) => !r.consumedAt);
    if (table === oauthConsents) return consents;
    return [];
  },
  insert: (table, values) => {
    const row = { id: fakeUuid(), createdAt: new Date(), ...values };
    if (table === oauthAuthorizationRequests) pendingRequests.push(row);
    if (table === oauthConsents) consents = [row];
    return row;
  },
  update: (table, set) => {
    if (table === oauthAuthorizationRequests) {
      const open = pendingRequests.find((r) => !r.consumedAt);
      if (!open) return [];
      Object.assign(open, set);
      return [open];
    }
    return [];
  },
});
log = fake.log;

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'oauth@example.test');
    await next();
  },
}));

mock.module('../config', () => ({
  config: { FRONTEND_URL: 'https://app.example', KORTIX_URL: 'https://api.example', API_KEY_SECRET: 'test-secret' },
}));

mock.module('../shared/db', () => ({ db: fake.db }));

const { oauthApp } = await import('../oauth');

function createApp() {
  const app = new Hono();
  app.route('/oauth', oauthApp);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: (err as Error).message }, 500);
  });
  return app;
}

function authRequestUrl(scope = 'profile kortix') {
  const url = new URL('http://api.example/oauth/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', 'https://client.example/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', 'state_abc');
  url.searchParams.set('code_challenge', 'challenge_123');
  url.searchParams.set('code_challenge_method', 'S256');
  return `${url.pathname}${url.search}`;
}

const authed = { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' };

describe('OAuth authorization request persistence + consent', () => {
  beforeEach(() => {
    pendingRequests = [];
    consents = [];
    log.inserts.length = 0;
    log.updates.length = 0;
  });

  test('the pending request is persisted (hashed id) and the consent UI gets only an opaque request id', async () => {
    const app = createApp();
    const start = await app.request(authRequestUrl());
    expect(start.status).toBe(302);
    const consentUrl = new URL(start.headers.get('location')!);
    expect(consentUrl.origin).toBe('https://app.example');
    expect(consentUrl.pathname).toBe('/oauth/authorize');
    expect(consentUrl.searchParams.get('client_name')).toBeNull();
    expect(consentUrl.searchParams.get('redirect_uri')).toBeNull();
    const requestId = consentUrl.searchParams.get('request_id')!;
    expect(requestId.length).toBeGreaterThan(30);

    expect(pendingRequests).toHaveLength(1);
    expect(pendingRequests[0]).toMatchObject({
      clientId: CLIENT_ID,
      redirectUri: 'https://client.example/callback',
      scopes: ['profile', 'kortix'],
      state: 'state_abc',
      codeChallenge: 'challenge_123',
    });
    // The capability itself is never stored, only its hash.
    expect(pendingRequests[0].requestIdHash).not.toBe(requestId);
    expect(String(pendingRequests[0].requestIdHash)).toMatch(/^[0-9a-f]{64}$/);

    const metadata = await app.request(`/oauth/authorize/consent/${requestId}`, { headers: authed });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      client_id: CLIENT_ID,
      client_name: 'Trusted Client',
      client_type: 'confidential',
      scope: 'profile kortix',
      scopes: ['profile', 'kortix'],
      remembered: false,
    });
  });

  test('approval mints a code from the STORED request, remembers the consent, and a replay is refused', async () => {
    const app = createApp();
    const start = await app.request(authRequestUrl());
    const requestId = new URL(start.headers.get('location')!).searchParams.get('request_id')!;

    const approved = await app.request('/oauth/authorize/consent', {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({
        request_id: requestId,
        approved: true,
        client_name: 'Spoofed Client',
        redirect_uri: 'javascript:alert(1)',
      }),
    });
    expect(approved.status).toBe(200);
    const redirect = new URL((await approved.json()).redirect_uri);
    expect(redirect.origin).toBe('https://client.example');
    expect(redirect.searchParams.get('state')).toBe('state_abc');
    expect(redirect.searchParams.get('code')).toBeTruthy();

    const codeInsert = log.inserts.find((i) => i.table === oauthAuthorizationCodes)!;
    expect(codeInsert.values).toMatchObject({
      clientId: CLIENT_ID,
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      redirectUri: 'https://client.example/callback',
      scopes: ['profile', 'kortix'],
      codeChallenge: 'challenge_123',
    });
    const consentInsert = log.inserts.find((i) => i.table === oauthConsents)!;
    expect(consentInsert.values).toMatchObject({ userId: USER_ID, clientId: CLIENT_ID, scopes: ['profile', 'kortix'] });

    const replay = await app.request('/oauth/authorize/consent', {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ request_id: requestId, approved: true }),
    });
    expect(replay.status).toBe(400);
  });

  test('a denial sends the user back with error=access_denied and writes no code and no consent', async () => {
    const app = createApp();
    const start = await app.request(authRequestUrl());
    const requestId = new URL(start.headers.get('location')!).searchParams.get('request_id')!;
    const denied = await app.request('/oauth/authorize/consent', {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ request_id: requestId, approved: false }),
    });
    expect(denied.status).toBe(200);
    const redirect = new URL((await denied.json()).redirect_uri);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('state_abc');
    expect(log.inserts.some((i) => i.table === oauthAuthorizationCodes)).toBe(false);
    expect(log.inserts.some((i) => i.table === oauthConsents)).toBe(false);
  });

  test('a remembered consent that covers the requested scopes is reported so the UI can skip the Allow screen', async () => {
    consents = [{ userId: USER_ID, clientId: CLIENT_ID, scopes: ['profile', 'kortix'] }];
    const app = createApp();
    const start = await app.request(authRequestUrl('profile'));
    const requestId = new URL(start.headers.get('location')!).searchParams.get('request_id')!;
    const metadata = await app.request(`/oauth/authorize/consent/${requestId}`, { headers: authed });
    expect((await metadata.json()).remembered).toBe(true);
  });

  test('a remembered consent that lacks a newly requested scope still asks', async () => {
    consents = [{ userId: USER_ID, clientId: CLIENT_ID, scopes: ['profile'] }];
    const app = createApp();
    const start = await app.request(authRequestUrl('profile kortix'));
    const requestId = new URL(start.headers.get('location')!).searchParams.get('request_id')!;
    const metadata = await app.request(`/oauth/authorize/consent/${requestId}`, { headers: authed });
    expect((await metadata.json()).remembered).toBe(false);
  });

  test('a scope the client was not registered for is invalid_scope', async () => {
    const app = createApp();
    const res = await app.request(authRequestUrl('profile email'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_scope');
  });
});
