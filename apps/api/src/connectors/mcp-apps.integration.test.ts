/**
 * Real-Postgres contract for signing in to a catalogue app with Kortix's own
 * OAuth client (connectors/mcp-apps.ts): registering without a
 * `registration_endpoint` saves Kortix's client with the catalogue's endpoints
 * and ignores any endpoint in the request, the authorization URL goes to the
 * vendor with that client, and a URL outside the catalogue gets no client.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import {
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
