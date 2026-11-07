/**
 * Real-Postgres contract for signing in to a catalogue app with Kortix's own
 * OAuth client (connectors/mcp-apps.ts): registering without a
 * `registration_endpoint` saves Kortix's client with the catalogue's endpoints
 * and ignores any endpoint in the request, the authorization URL goes to the
 * vendor with that client, and a URL outside the catalogue gets no client.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { accounts, connectionCredentials, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { resolveConnectionCredentialValue } from './credentials';
import {
  completeAuthorizationCodeSession,
  createAuthorizationCodeSession,
  loadOAuth2Application,
  registerConnectionOAuth2Client,
} from './oauth2-store';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const CALLBACK = 'https://api.kortix.test/v1/connectors/oauth2/callback';

function identity(connectorId: string, connectionId: string) {
  return { accountId: ACCOUNT, projectId: PROJECT, connectorId, connectionId };
}

async function connection(slug: string, url: string) {
  const connectorId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  await db.insert(connectors).values({ connectorId, accountId: ACCOUNT, projectId: PROJECT, slug, name: slug, providerType: 'mcp', config: { url, transport: 'http' } });
  await db.insert(connectorConnections).values({ connectionId, accountId: ACCOUNT, projectId: PROJECT, connectorId, label: 'Shared account' });
  return identity(connectorId, connectionId);
}

let previousClients = '';

beforeAll(async () => {
  previousClients = config.KORTIX_OAUTH_CLIENTS;
  (config as { KORTIX_OAUTH_CLIENTS: string }).KORTIX_OAUTH_CLIENTS = JSON.stringify({
    google: { client_id: 'kortix-google-client', client_secret: 'kortix-google-secret' },
    x: { client_id: 'kortix-x-client', client_secret: 'kortix-x-secret' },
  });
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'mcp-apps-test' });
  await db.insert(projects).values({ projectId: PROJECT, accountId: ACCOUNT, name: 'mcp-apps', repoUrl: 'https://example.test/m.git' });
});

afterAll(async () => {
  (config as { KORTIX_OAUTH_CLIENTS: string }).KORTIX_OAUTH_CLIENTS = previousClients;
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

test('registering a catalogue app without dynamic registration saves Kortix’s client and the catalogue’s endpoints', async () => {
  const gmail = await connection('gmail', 'https://gmailmcp.googleapis.com/mcp/v1');
  await registerConnectionOAuth2Client({
    identity: gmail,
    // Everything a caller could send is ignored: the catalogue is the trust anchor.
    registration: { token_url: 'https://evil.example/token', authorization_url: 'https://evil.example/authorize', scopes: ['https://mail.google.com/'] },
    callbackUrl: CALLBACK,
    createdBy: USER,
  });
  const saved = await loadOAuth2Application(gmail.connectionId);
  expect(saved?.application).toMatchObject({
    client_id: 'kortix-google-client',
    client_secret: 'kortix-google-secret',
    token_url: 'https://oauth2.googleapis.com/token',
    authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint_auth_method: 'client_secret_post',
  });
  expect(saved?.application.scopes).not.toContain('https://mail.google.com/');

  const started = await createAuthorizationCodeSession({ connectionId: gmail.connectionId, initiatedBy: USER, callbackUrl: CALLBACK });
  const url = new URL(started.authorizationUrl);
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(url.searchParams.get('client_id')).toBe('kortix-google-client');
  expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(url.searchParams.get('prompt')).toBe('consent');
  expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/gmail.readonly');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(started.authorizationUrl).not.toContain('kortix-google-secret');
});

test('a server outside the catalogue gets no Kortix client, even when it names Google as its authorization server', async () => {
  const evil = await connection('lookalike', 'https://mcp.evil.example/mcp');
  await expect(
    registerConnectionOAuth2Client({
      identity: evil,
      registration: { issuer: 'https://accounts.google.com', token_url: 'https://oauth2.googleapis.com/token' },
      callbackUrl: CALLBACK,
      createdBy: USER,
    }),
  ).rejects.toThrow('Kortix has no OAuth client for this server');
  expect(await loadOAuth2Application(evil.connectionId)).toBeNull();
});

test('X: start, callback, stored credential and refresh with Kortix’s X client, against a stubbed X token endpoint', async () => {
  const x = await connection('x', 'https://api.x.com/mcp');
  await registerConnectionOAuth2Client({ identity: x, registration: {}, callbackUrl: CALLBACK, createdBy: USER });
  expect((await loadOAuth2Application(x.connectionId))?.application).toMatchObject({
    client_id: 'kortix-x-client',
    token_url: 'https://api.x.com/2/oauth2/token',
    token_endpoint_auth_method: 'client_secret_basic',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  });

  const started = await createAuthorizationCodeSession({ connectionId: x.connectionId, initiatedBy: USER, callbackUrl: CALLBACK });
  const authorize = new URL(started.authorizationUrl);
  expect(authorize.origin + authorize.pathname).toBe('https://x.com/i/oauth2/authorize');
  expect(authorize.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access');
  const state = authorize.searchParams.get('state');
  if (!state) throw new Error('no state');

  // X's token endpoint: the first call redeems the code, the second refreshes.
  // safeEgressFetch pins the resolved address, so match on the Host header.
  const grants: URLSearchParams[] = [];
  const basic = `Basic ${Buffer.from('kortix-x-client:kortix-x-secret').toString('base64')}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = new URL(String(input instanceof Request ? input.url : input));
    const host = headers.get('host') ?? url.host;
    if (host === 'api.x.com' && url.pathname === '/2/oauth2/token') {
      if (headers.get('authorization') !== basic) return new Response('{"error":"invalid_client"}', { status: 401 });
      const body = new URLSearchParams(String(init?.body));
      grants.push(body);
      const n = grants.length;
      // A 30 s lifetime: the next read is inside the refresh window.
      return Response.json({ token_type: 'bearer', expires_in: 30, access_token: `x-access-${n}`, refresh_token: `x-refresh-${n}`, scope: 'tweet.read tweet.write users.read offline.access' });
    }
    if (host === 'api.x.com') return new Response('{}', { status: 401 });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const done = await completeAuthorizationCodeSession({
      stateHash: createHash('sha256').update(state).digest('hex'),
      code: 'x-code',
      callbackUrl: CALLBACK,
      issuer: 'https://api.x.com',
    });
    expect(done.ok).toBe(true);
    expect(grants[0]?.get('grant_type')).toBe('authorization_code');
    expect(grants[0]?.get('code')).toBe('x-code');
    expect(grants[0]?.get('code_verifier')).toBeTruthy();
    expect(grants[0]?.has('client_id')).toBe(false);

    const accessToken = await resolveConnectionCredentialValue({ connectorId: x.connectorId, connectionId: x.connectionId });
    expect(accessToken).toBe('x-access-2');
    expect(grants[1]?.get('grant_type')).toBe('refresh_token');
    expect(grants[1]?.get('refresh_token')).toBe('x-refresh-1');
    // X rotates the refresh token: the stored credential carries the new one.
    expect(await resolveConnectionCredentialValue({ connectorId: x.connectorId, connectionId: x.connectionId })).toBe('x-access-3');
    expect(grants[2]?.get('refresh_token')).toBe('x-refresh-2');
  } finally {
    globalThis.fetch = realFetch;
  }
  const [row] = await db
    .select({ kind: connectionCredentials.kind })
    .from(connectionCredentials)
    .where(eq(connectionCredentials.connectionId, x.connectionId));
  expect(row?.kind).toBe('oauth2_delegated');
});
