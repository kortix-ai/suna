/**
 * Real-Postgres contract for connecting a native Shopify account: Connect's
 * form link, the form submit (an OAuth application and a session row), the
 * callback (state, HMAC, store, code exchange, credential, access check), the
 * store a call goes to, and finalize across a reconnect.
 *
 * Shopify is a fake fetch. The connection rows, the session table and its
 * CHECK constraints, the credential encryption and the SQL are real.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { accounts, connectionCredentials, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { FetchImpl } from './call';
import { dbConnectorRouterDeps } from './db-deps';
import { appFormInfo, submitAppForm } from './app-form';
import { resolveConnectionCredentialValue } from './credentials';
import { completeShopifyCallback, shopifyStoreForConnection } from './shopify-connect';
import { SHOPIFY_AUTH } from './shopify';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const SECRET = 'test-client-secret';

const shopify: FetchImpl = async (url, init) => {
  const reply = (status: number, body: unknown) => ({
    status,
    ok: status < 300,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  });
  if (url.endsWith('/admin/oauth/access_token')) {
    const form = new URLSearchParams(init.body);
    return form.get('client_secret') === SECRET && form.get('code') === 'code-1'
      ? reply(200, { access_token: 'token-1', scope: 'read_orders,read_products' })
      : reply(400, { error: 'invalid_request' });
  }
  if (url.endsWith('/graphql.json')) {
    return reply(200, {
      data: { shop: { name: 'Test Store', myshopifyDomain: 'acme.myshopify.com', currencyCode: 'EUR' }, products: { nodes: [] }, orders: null, customers: null, inventoryItems: { nodes: [] } },
      errors: [
        { message: 'This app is not approved to access the Order object.', extensions: { code: 'ACCESS_DENIED' }, path: ['orders'] },
        { message: 'This app is not approved to access the Customer object.', extensions: { code: 'ACCESS_DENIED' }, path: ['customers'] },
      ],
    });
  }
  return reply(404, {});
};

function callbackUrl(query: Record<string, string>, secret = SECRET): string {
  const message = Object.entries(query).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const params = new URLSearchParams({ ...query, hmac: createHmac('sha256', secret).update(message).digest('hex') });
  return `https://api.example.test/v1/connectors/shopify/callback?${params}`;
}

async function connect() {
  const started = await dbConnectorRouterDeps.connectorConnect!(PROJECT, 'shop', MEMBER, undefined, null, 'me');
  expect(started?.provider).toBe('shopify');
  const token = /\/connect\/app\/(kaf_[A-Za-z0-9_-]+)$/.exec(started!.connectUrl!)?.[1];
  expect(token).toBeDefined();
  return { token: token!, connectionId: started!.connectionId! };
}

async function submit(token: string, store = 'acme') {
  const result = await submitAppForm(token, { store, client_id: 'client-id', client_secret: SECRET });
  expect(result.connected).toBe(false);
  return new URL((result as { authorize_url: string }).authorize_url).searchParams.get('state')!;
}

const finalize = async () =>
  (await dbConnectorRouterDeps.connectorFinalize!(PROJECT, 'shop', MEMBER, undefined, 'me'))?.connected;

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'shopify-connect-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'shopify-connect-test',
    repoUrl: 'https://example.test/shopify-connect.git',
  });
  await db.insert(connectors).values({
    connectorId: CONNECTOR,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'shop',
    name: 'Shopify',
    providerType: 'shopify',
    config: { shop: 'acme.myshopify.com', scopes: null, auth: { ...SHOPIFY_AUTH } },
  });
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('Shopify connect', () => {
  let connectionId = '';
  let firstToken = '';

  test('a full grant stores the token for its store and records what it can read', async () => {
    const started = await connect();
    connectionId = started.connectionId;
    firstToken = started.token;
    expect(await finalize()).toBe(false);
    const info = await appFormInfo(started.token);
    expect(info).toMatchObject({ flow: 'oauth', shop: 'acme.myshopify.com', shared_app: false, connected: false });

    const state = await submit(started.token);
    const outcome = await completeShopifyCallback(
      callbackUrl({ code: 'code-1', shop: 'acme.myshopify.com', state, timestamp: '1' }),
      shopify,
    );
    expect(outcome.status).toBe(302);
    expect((outcome as { location: string }).location).toEndWith(`/connect/app/${started.token}?connected=1`);

    const [credential] = await db.select().from(connectionCredentials).where(eq(connectionCredentials.connectionId, connectionId));
    expect(credential?.kind).toBe('oauth2_delegated');
    expect(await resolveConnectionCredentialValue({ connectorId: CONNECTOR, connectionId })).toBe('token-1');
    expect(await shopifyStoreForConnection({ connectorId: CONNECTOR, connectionId })).toBe('acme.myshopify.com');

    const [row] = await db.select().from(connectorConnections).where(eq(connectorConnections.connectionId, connectionId));
    const metadata = row!.metadata as Record<string, any>;
    expect(row!.label).toBe('acme.myshopify.com');
    expect(metadata.connected_as).toBe('acme.myshopify.com');
    expect(metadata.shopify.access).toMatchObject({ catalog: 'ok', orders: 'blocked', customers: 'blocked', inventory: 'ok' });
    expect(metadata.shopify.connected_request).toBe(metadata.auth_request_id);
    expect(await finalize()).toBe(true);
    expect(await appFormInfo(started.token)).toMatchObject({ connected: true, connected_as: 'acme.myshopify.com' });
  });

  test('a used state is refused', async () => {
    const outcome = await completeShopifyCallback(
      callbackUrl({ code: 'code-1', shop: 'acme.myshopify.com', state: 'never-issued', timestamp: '1' }),
      shopify,
    );
    expect(outcome.status).toBe(400);
  });

  test('a reconnect stays open until its own grant: the old token does not count', async () => {
    const again = await connect();
    expect(again.connectionId).toBe(connectionId);
    expect(await finalize()).toBe(false);
    await expect(appFormInfo(firstToken)).rejects.toMatchObject({ status: 409 });
    expect(await appFormInfo(again.token)).toMatchObject({ connected: false });
    // The account keeps calling its store with the old token meanwhile.
    expect(await shopifyStoreForConnection({ connectorId: CONNECTOR, connectionId })).toBe('acme.myshopify.com');

    const badSignature = await completeShopifyCallback(
      callbackUrl({ code: 'code-1', shop: 'acme.myshopify.com', state: await submit(again.token), timestamp: '1' }, 'wrong-secret'),
      shopify,
    );
    expect((badSignature as { location: string }).location).toContain('error=invalid_signature');

    const otherStore = await completeShopifyCallback(
      callbackUrl({ code: 'code-1', shop: 'other.myshopify.com', state: await submit(again.token), timestamp: '1' }),
      shopify,
    );
    expect((otherStore as { location: string }).location).toContain('error=shop_mismatch');

    // A form saved for another store does not move the account's calls.
    await submit(again.token, 'elsewhere');
    expect(await shopifyStoreForConnection({ connectorId: CONNECTOR, connectionId })).toBe('acme.myshopify.com');
    expect(await finalize()).toBe(false);
  });
});
