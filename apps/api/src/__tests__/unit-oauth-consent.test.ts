import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  accountMembers,
  oauthAuthorizationCodes,
  oauthClients,
} from '@kortix/db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-a000-000000000101';

const insertedCodes: Array<Record<string, unknown>> = [];

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: any, next: any) => {
    c.set('userId', USER_ID);
    c.set('userEmail', 'oauth@example.test');
    await next();
  },
}));

mock.module('../config', () => ({
  config: {
    FRONTEND_URL: 'https://app.example',
  },
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === oauthClients) {
              return [{
                clientId: 'client_123',
                name: 'Trusted Client',
                redirectUris: ['https://client.example/callback'],
                scopes: ['profile', 'machines:read'],
                active: true,
              }];
            }
            if (table === accountMembers) {
              return [{ accountId: ACCOUNT_ID }];
            }
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table === oauthAuthorizationCodes) insertedCodes.push(values);
      },
    }),
  },
}));

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

function authRequestUrl() {
  const url = new URL('http://api.example/oauth/authorize');
  url.searchParams.set('client_id', 'client_123');
  url.searchParams.set('redirect_uri', 'https://client.example/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'profile machines:read');
  url.searchParams.set('state', 'state_abc');
  url.searchParams.set('code_challenge', 'challenge_123');
  url.searchParams.set('code_challenge_method', 'S256');
  return `${url.pathname}${url.search}`;
}

describe('OAuth authorization consent request binding', () => {
  beforeEach(() => {
    insertedCodes.length = 0;
  });

  test('passes only an opaque request id to the consent UI and uses stored request fields', async () => {
    const app = createApp();

    const start = await app.request(authRequestUrl());
    expect(start.status).toBe(302);
    const location = start.headers.get('location');
    expect(location).toBeTruthy();

    const consentUrl = new URL(location!);
    expect(consentUrl.origin).toBe('https://app.example');
    expect(consentUrl.searchParams.get('client_name')).toBeNull();
    expect(consentUrl.searchParams.get('redirect_uri')).toBeNull();
    const requestId = consentUrl.searchParams.get('request_id');
    expect(requestId).toBeTruthy();

    const metadata = await app.request(`/oauth/authorize/consent/${requestId}`, {
      headers: { Authorization: 'Bearer jwt' },
    });
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      client_id: 'client_123',
      client_name: 'Trusted Client',
      scopes: ['profile', 'machines:read'],
    });

    const approved = await app.request('/oauth/authorize/consent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer jwt',
      },
      body: JSON.stringify({
        request_id: requestId,
        approved: true,
        client_name: 'Spoofed Client',
        redirect_uri: 'javascript:alert(1)',
      }),
    });
    expect(approved.status).toBe(200);
    const approvedBody = await approved.json();
    const redirect = new URL(approvedBody.redirect_uri);
    expect(redirect.origin).toBe('https://client.example');
    expect(redirect.searchParams.get('state')).toBe('state_abc');
    expect(redirect.searchParams.get('code')).toBeTruthy();
    expect(insertedCodes).toHaveLength(1);
    expect(insertedCodes[0]).toMatchObject({
      clientId: 'client_123',
      redirectUri: 'https://client.example/callback',
      scopes: ['profile', 'machines:read'],
      codeChallenge: 'challenge_123',
    });

    const replay = await app.request('/oauth/authorize/consent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer jwt',
      },
      body: JSON.stringify({ request_id: requestId, approved: true }),
    });
    expect(replay.status).toBe(400);
  });
});
