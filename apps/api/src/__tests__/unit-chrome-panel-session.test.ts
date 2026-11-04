// POST /v1/chrome/panel-session: only an OAuth token issued to the verified
// Kortix in Chrome client gets a one-time token hash. Every other credential
// gets 403 chrome_panel_forbidden and never reaches GoTrue.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { oauthClients } from '@kortix/db';
import { createFakeDb } from './oauth-fake-db';

const USER_ID = '00000000-0000-4000-a000-000000000001';
const EXTENSION_CLIENT = '00000000-0000-4000-a000-000000000301';
const OTHER_CLIENT = '00000000-0000-4000-a000-000000000302';
const EXTENSION_URI = 'chrome-extension://gefbbnjgoiljpbnalgafbhbfdhikgjek/welcome.html';

let clientRows: Record<string, unknown>[] = [];
const fake = createFakeDb({ select: (table) => (table === oauthClients ? clientRows : []) });
const realDb = await import('../shared/db');
mock.module('../shared/db', () => ({ ...realDb, db: fake.db }));

let email: string | null = 'person@example.test';
const calls = { getUserById: 0, generateLink: [] as unknown[] };
const realSupabase = await import('../shared/supabase');
mock.module('../shared/supabase', () => ({
  ...realSupabase,
  getSupabase: () => ({
    auth: {
      admin: {
        getUserById: async () => {
          calls.getUserById++;
          return { data: { user: { id: USER_ID, email } }, error: null };
        },
        generateLink: async (args: unknown) => {
          calls.generateLink.push(args);
          return { data: { properties: { hashed_token: 'hash_abc' } }, error: null };
        },
      },
    },
  }),
}));

const { chromeApp, registerChromeRoutes } = await import('../chrome/routes');
registerChromeRoutes();

function appFor(credential: { authType?: string; oauthClientId?: string; userId?: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId' as never, (credential.userId ?? USER_ID) as never);
    if (credential.authType) c.set('authType' as never, credential.authType as never);
    if (credential.oauthClientId) c.set('oauthClientId' as never, credential.oauthClientId as never);
    await next();
  });
  app.route('/v1/chrome', chromeApp);
  return app;
}

const post = (app: Hono) => app.request('/v1/chrome/panel-session', { method: 'POST' });

beforeEach(() => {
  email = 'person@example.test';
  calls.getUserById = 0;
  calls.generateLink = [];
  clientRows = [{ redirectUris: [EXTENSION_URI] }];
});

describe('POST /v1/chrome/panel-session authorization matrix', () => {
  test('OAuth token of the extension client: 200 with a tokenHash, magiclink for the user email', async () => {
    const res = await post(appFor({ authType: 'oauth', oauthClientId: EXTENSION_CLIENT, userId: '00000000-0000-4000-a000-0000000000a1' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ tokenHash: 'hash_abc' });
    expect(calls.generateLink).toEqual([{ type: 'magiclink', email: 'person@example.test' }]);
  });

  test('OAuth token of another client: 403 chrome_panel_forbidden, GoTrue untouched', async () => {
    clientRows = [{ redirectUris: ['https://client.example/callback'] }];
    const res = await post(appFor({ authType: 'oauth', oauthClientId: OTHER_CLIENT }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('chrome_panel_forbidden');
    expect(calls.generateLink).toHaveLength(0);
  });

  test('a client with the extension URI plus a second URI is not the extension', async () => {
    clientRows = [{ redirectUris: [EXTENSION_URI, 'https://client.example/cb'] }];
    const res = await post(appFor({ authType: 'oauth', oauthClientId: OTHER_CLIENT }));
    expect(res.status).toBe(403);
  });

  test.each([
    ['PAT', { authType: 'pat' }],
    ['Supabase JWT', { authType: 'supabase' }],
    ['session sandbox token', { authType: 'apiKey' }],
    ['service account', { authType: 'service_account' }],
    ['OAuth token without a client id', { authType: 'oauth' }],
  ])('%s: 403 chrome_panel_forbidden', async (_name, credential) => {
    const res = await post(appFor(credential));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('chrome_panel_forbidden');
    expect(calls.generateLink).toHaveLength(0);
  });

  test('a user without an email: 409 chrome_panel_no_email', async () => {
    email = null;
    const res = await post(appFor({ authType: 'oauth', oauthClientId: EXTENSION_CLIENT, userId: '00000000-0000-4000-a000-0000000000a2' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('chrome_panel_no_email');
  });

  test('11th request in a minute: 429 with Retry-After', async () => {
    const credential = { authType: 'oauth', oauthClientId: EXTENSION_CLIENT, userId: '00000000-0000-4000-a000-0000000000a3' };
    for (let i = 0; i < 10; i++) expect((await post(appFor(credential))).status).toBe(200);
    const res = await post(appFor(credential));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
