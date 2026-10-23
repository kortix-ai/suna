import { describe, expect, test } from 'bun:test';
import type { HTTPException } from 'hono/http-exception';
import {
  composioConnectUrl,
  composioUserId,
  connectOwnApp,
  type ComposioRuntime,
  type ComposioSessionLike,
} from './composio';
import { customAuthConfigIds, type ComposioCatalogClient } from './composio-catalog-search';
import { mintAppFormToken, normalizeShopifyStore, openAppFormToken } from './composio-own-app';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const CONNECTION = '00000000-0000-4000-8000-0000000000c1';
const CONFIG_NAME = `kortix-connection:${CONNECTION}`;

describe('normalizeShopifyStore', () => {
  test('accepts the name, the myshopify host, a store URL, and an admin URL', () => {
    expect(normalizeShopifyStore('acme')).toBe('acme');
    expect(normalizeShopifyStore(' Acme-Store.myshopify.com ')).toBe('acme-store');
    expect(normalizeShopifyStore('https://acme.myshopify.com/admin/products?x=1')).toBe('acme');
    expect(normalizeShopifyStore('https://admin.shopify.com/store/acme-2/orders')).toBe('acme-2');
  });

  test('refuses custom domains, paths and empty input', () => {
    expect(normalizeShopifyStore('shop.acme.com')).toBeNull();
    expect(normalizeShopifyStore('acme store')).toBeNull();
    expect(normalizeShopifyStore('')).toBeNull();
    expect(normalizeShopifyStore(42)).toBeNull();
  });
});

describe('app form token', () => {
  const mint = (now = Date.now()) =>
    mintAppFormToken({ projectId: PROJECT, connectionId: CONNECTION, app: 'Shopify', nonce: 'n-1', now });

  test('opens to the connection, app and nonce it was minted for', () => {
    const opened = openAppFormToken(mint());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.payload).toMatchObject({ pid: PROJECT, cid: CONNECTION, app: 'shopify', n: 'n-1' });
  });

  test('keeps only an allowed success redirect', () => {
    const allowed = openAppFormToken(
      mintAppFormToken({ projectId: PROJECT, connectionId: CONNECTION, app: 'shopify', nonce: 'n', successRedirect: 'kortix://connected' }),
    );
    const foreign = openAppFormToken(
      mintAppFormToken({ projectId: PROJECT, connectionId: CONNECTION, app: 'shopify', nonce: 'n', successRedirect: 'https://evil.test/x' }),
    );
    expect(allowed.ok && allowed.payload.ok).toBe('kortix://connected');
    expect(foreign.ok && foreign.payload.ok).toBeUndefined();
  });

  test('an expired link answers 410, a tampered or foreign one 404', () => {
    expect(openAppFormToken(mint(Date.now() - 2 * 60 * 60_000))).toMatchObject({ ok: false, status: 410 });
    const token = mint();
    const tampered = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(openAppFormToken(tampered)).toMatchObject({ ok: false, status: 404 });
    const decoded = Buffer.from(token.slice(4), 'base64url').toString('utf8');
    const moved = 'kaf_' + Buffer.from(decoded.replace(PROJECT, '00000000-0000-4000-8000-000000000002'), 'utf8').toString('base64url');
    expect(openAppFormToken(moved)).toMatchObject({ ok: false, status: 404 });
    expect(openAppFormToken('ksl_abc')).toMatchObject({ ok: false, status: 404 });
  });
});

type ToolkitItem = Awaited<ReturnType<ComposioSessionLike['toolkits']>>['items'][number];

function session(id: string, activeAccount: string | null): ComposioSessionLike {
  const toolkit: ToolkitItem = {
    slug: 'shopify',
    name: 'Shopify',
    isNoAuth: false,
    connection: activeAccount
      ? { isActive: true, connectedAccount: { id: activeAccount, status: 'ACTIVE' } }
      : undefined,
  } as ToolkitItem;
  return {
    sessionId: id,
    tools: async () => [],
    toolkits: async () => ({ items: [toolkit], cursor: undefined, totalPages: 1 }),
    authorize: async () => {
      throw new Error('the hosted page must not be used for an own-app toolkit');
    },
    execute: async () => ({ data: {}, error: null, logId: 'log' }),
  } as ComposioSessionLike;
}

function runtime(activeAccount: string | null, calls: Array<Record<string, unknown>>): ComposioRuntime {
  return {
    sessions: {
      async create(userId, config) {
        calls.push({ type: 'session', userId, config });
        return session('trs_bound', activeAccount);
      },
      async use(sessionId) {
        return session(sessionId, activeAccount);
      },
    },
  };
}

interface FakeConfig {
  id: string;
  name: string;
  status: 'ENABLED';
  is_composio_managed: false;
  toolkit: { slug: string };
  created_at: string;
}

function restClient(input: {
  configs?: FakeConfig[];
  accountError?: Error;
  calls: Array<Record<string, unknown>>;
}): ComposioCatalogClient {
  const configs = input.configs ?? [];
  return {
    toolkits: { list: async () => ({ items: [], next_cursor: null }) },
    authConfigs: {
      async list(query) {
        input.calls.push({ type: 'list', query });
        return { items: configs.filter((row) => !query.search || row.name.includes(query.search)), next_cursor: null };
      },
      async create(body) {
        input.calls.push({ type: 'create-config', body });
        return { auth_config: { id: 'ac_new' } };
      },
      async delete(id) {
        input.calls.push({ type: 'delete-config', id });
        return {};
      },
    },
    connectedAccounts: {
      async create(body) {
        input.calls.push({ type: 'create-account', body });
        if (input.accountError) throw input.accountError;
        return { id: 'ca_new', status: 'ACTIVE' };
      },
    },
  };
}

const ownConfig = (id: string): FakeConfig => ({
  id,
  name: CONFIG_NAME,
  status: 'ENABLED',
  is_composio_managed: false,
  toolkit: { slug: 'shopify' },
  created_at: '2026-10-01T00:00:00Z',
});

describe('Shopify connect', () => {
  const connectInput = {
    projectId: PROJECT,
    slug: 'store',
    app: 'shopify',
    connectionId: CONNECTION,
    stableUserId: composioUserId(CONNECTION),
  };

  test('a connection without its own app gets the Kortix form link, not Composio\'s token page', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await composioConnectUrl({
      ...connectInput,
      runtime: runtime(null, calls),
      catalogClient: restClient({ calls }),
    });
    expect(result.connected).toBe(false);
    expect(result.sessionId).toBe('');
    expect(result.connectUrl).toMatch(/\/connect\/app\/kaf_[A-Za-z0-9_-]+$/);
    const opened = openAppFormToken(result.connectUrl!.split('/').pop());
    expect(opened.ok && opened.payload.n).toBe(result.authRequestId!);
    expect(calls.filter((call) => call.type === 'session')).toHaveLength(0);
  });

  test('a connection whose own app holds an active account stays connected on its own config', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await composioConnectUrl({
      ...connectInput,
      runtime: runtime('ca_live', calls),
      catalogClient: restClient({ calls, configs: [ownConfig('ac_own')] }),
    });
    expect(result).toMatchObject({ connected: true, connectedAccountId: 'ca_live', sessionId: 'trs_bound' });
    const created = calls.find((call) => call.type === 'session') as { config: { authConfigs?: Record<string, string> } };
    expect(created.config.authConfigs).toEqual({ shopify: 'ac_own' });
  });

  test('connectOwnApp makes a client-credentials config and account, then retires the earlier config', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await connectOwnApp({
      connectionId: CONNECTION,
      toolkit: 'shopify',
      store: 'acme',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      runtime: runtime('ca_new', calls),
      catalogClient: restClient({ calls, configs: [ownConfig('ac_old')] }),
    });
    expect(result).toEqual({ sessionId: 'trs_bound', connectedAccountId: 'ca_new' });
    const config = calls.find((call) => call.type === 'create-config') as { body: Record<string, any> };
    expect(config.body.auth_config).toMatchObject({
      authScheme: 'S2S_OAUTH2',
      name: CONFIG_NAME,
      credentials: { client_id: 'client-id', client_secret: 'client-secret' },
    });
    const account = calls.find((call) => call.type === 'create-account') as { body: Record<string, any> };
    expect(account.body).toMatchObject({
      auth_config: { id: 'ac_new' },
      connection: { user_id: composioUserId(CONNECTION), state: { val: { subdomain: 'acme' } } },
    });
    const bound = calls.find((call) => call.type === 'session') as { config: Record<string, any> };
    expect(bound.config).toMatchObject({ authConfigs: { shopify: 'ac_new' }, connectedAccounts: { shopify: 'ca_new' } });
    expect(calls.filter((call) => call.type === 'delete-config').map((call) => call.id)).toEqual(['ac_old']);
  });

  test.each([
    ['S2S token exchange failed (HTTP 400): <title>400 - Oauth error application_cannot_be_found</title>', 'application_cannot_be_found', /no app with this Client ID/],
    ['S2S token exchange failed (HTTP 404): <title>Store unavailable</title>', undefined, /No Shopify store answers at acme\.myshopify\.com/],
    ['S2S token exchange failed (HTTP 400): Oauth error shop_not_permitted: Client credentials cannot be performed', 'shop_not_permitted', /different Shopify organization/],
    ['S2S token exchange failed (HTTP 401): {"error":"invalid_client"}', undefined, /refused the Client ID or secret .*HTTP 401/],
  ])('Shopify refusing the exchange answers 422 with its reason, and keeps nothing (%s)', async (upstream, reason, message) => {
    const calls: Array<Record<string, unknown>> = [];
    const error = (await connectOwnApp({
      connectionId: CONNECTION,
      toolkit: 'shopify',
      store: 'acme',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      runtime: runtime(null, calls),
      catalogClient: restClient({ calls, configs: [ownConfig('ac_old')], accountError: new Error(`400 {"error":{"message":"${upstream}"}}`) }),
    }).catch((caught: unknown) => caught)) as HTTPException;
    expect(error.status).toBe(422);
    const body = (await error.getResponse().json()) as Record<string, unknown>;
    expect(body.code).toBe('shopify_refused');
    expect(body.reason).toBe(reason);
    expect(String(body.message)).toMatch(message);
    // The new config goes; the working earlier one stays.
    expect(calls.filter((call) => call.type === 'delete-config').map((call) => call.id)).toEqual(['ac_new']);
    expect(calls.filter((call) => call.type === 'session')).toHaveLength(0);
  });
});

test('a connection\'s own app is never the deployment-wide auth config', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = restClient({
    calls,
    configs: [
      { ...ownConfig('ac_customer'), created_at: '2026-10-02T00:00:00Z' },
      { ...ownConfig('ac_operator'), name: 'operator shopify', created_at: '2026-09-01T00:00:00Z' },
    ],
  });
  expect((await customAuthConfigIds({ catalogClient: client, toolkit: 'shopify' })).get('shopify')).toBe('ac_operator');
});
