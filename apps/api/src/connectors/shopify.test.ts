import { describe, expect, test } from 'bun:test';
import type { FetchImpl } from './call';
import {
  PROTECTED_DATA_REMEDIATION,
  SHOPIFY_API_VERSION,
  accessFromProbe,
  exchangeShopifyCode,
  executeShopifyCall,
  shopifyAuthorizeUrl,
  shopifyCatalog,
  shopifyGid,
  shopifyShopDomain,
  shopifyStoreOrigin,
  verifyShopifyHmac,
} from './shopify';

const STORE = 'https://acme.myshopify.com';

function fakeFetch(
  reply: { status?: number; body: unknown; headers?: Record<string, string> },
  calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> = [],
): FetchImpl {
  return async (url, init) => {
    calls.push({ url, init });
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)),
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
    };
  };
}

describe('store names', () => {
  test('a name, host, store URL or admin URL becomes the myshopify.com host', () => {
    expect(shopifyShopDomain('acme')).toBe('acme.myshopify.com');
    expect(shopifyShopDomain(' Acme.myshopify.com ')).toBe('acme.myshopify.com');
    expect(shopifyShopDomain('https://acme.myshopify.com/admin/orders')).toBe('acme.myshopify.com');
    expect(shopifyShopDomain('https://admin.shopify.com/store/acme-2/products')).toBe('acme-2.myshopify.com');
  });

  test('a custom domain or a look-alike host is refused', () => {
    expect(shopifyShopDomain('shop.acme.com')).toBeNull();
    expect(shopifyShopDomain('acme.myshopify.com.attacker.example')).toBeNull();
    expect(() => shopifyStoreOrigin('acme.myshopify.com.attacker.example')).toThrow();
  });

  test('the store origin is https://<shop>, or the local override', () => {
    expect(shopifyStoreOrigin('acme.myshopify.com')).toBe(STORE);
    expect(shopifyStoreOrigin('acme.myshopify.com', 'http://127.0.0.1:9999/')).toBe('http://127.0.0.1:9999');
  });
});

describe('OAuth', () => {
  test("Shopify's documented HMAC example verifies; a changed parameter does not", () => {
    const params = new URLSearchParams(
      'code=0907a61c0c8d55e99db179b68161bc00&hmac=4712bf92ffc2917d15a2f5a273e39f0116667419aa4b6ac0b3baaf26fa3c4d20&shop=some-shop.myshopify.com&timestamp=1337178173',
    );
    expect(verifyShopifyHmac(params, 'hush')).toBe(true);
    expect(verifyShopifyHmac(params, 'wrong-secret')).toBe(false);
    params.set('shop', 'other-shop.myshopify.com');
    expect(verifyShopifyHmac(params, 'hush')).toBe(false);
    expect(verifyShopifyHmac(new URLSearchParams('shop=a.myshopify.com'), 'hush')).toBe(false);
  });

  test('the authorize URL carries comma-separated scopes, the redirect and the state', () => {
    const url = new URL(
      shopifyAuthorizeUrl({
        origin: STORE,
        clientId: 'client-id',
        scopes: ['read_orders', 'read_products'],
        redirectUri: 'https://api.example.test/v1/connectors/shopify/callback',
        state: 'state-1',
      }),
    );
    expect(url.origin + url.pathname).toBe(`${STORE}/admin/oauth/authorize`);
    expect(url.searchParams.get('scope')).toBe('read_orders,read_products');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  test('the code exchange posts the client credentials and reads a permanent token', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> = [];
    const token = await exchangeShopifyCode(
      { origin: STORE, clientId: 'client-id', clientSecret: 'client-secret', code: 'code-1' },
      fakeFetch({ body: { access_token: 'token-1', scope: 'read_orders,read_products' } }, calls),
    );
    expect(token).toEqual({ accessToken: 'token-1', scopes: ['read_orders', 'read_products'] });
    expect(calls[0]!.url).toBe(`${STORE}/admin/oauth/access_token`);
    expect(new URLSearchParams(calls[0]!.init.body).get('client_secret')).toBe('client-secret');
    expect(new URLSearchParams(calls[0]!.init.body).has('expiring')).toBe(false);
  });

  test('an expiring token keeps its lifetime and refresh token', async () => {
    const token = await exchangeShopifyCode(
      { origin: STORE, clientId: 'c', clientSecret: 's', code: 'x', expiring: true },
      fakeFetch({ body: { access_token: 't', scope: '', expires_in: 3600, refresh_token: 'r' } }),
    );
    expect(token).toMatchObject({ expiresIn: 3600, refreshToken: 'r' });
  });

  test("a refused exchange names Shopify's reason", async () => {
    await expect(
      exchangeShopifyCode(
        { origin: STORE, clientId: 'c', clientSecret: 's', code: 'x' },
        fakeFetch({ status: 400, body: '<html><title>400 - Oauth error invalid_request</title></html>' }),
      ),
    ).rejects.toThrow(/HTTP 400: 400 - Oauth error invalid_request/);
  });
});

describe('catalog', () => {
  test('every shopify connector gets the same 16 actions, each a shopify binding', () => {
    const catalog = shopifyCatalog();
    expect(catalog.map((a) => a.path)).toEqual([
      'graphql',
      'check_access',
      'get_shop',
      'list_orders',
      'get_order',
      'list_draft_orders',
      'create_draft_order',
      'delete_draft_order',
      'list_customers',
      'list_products',
      'get_product',
      'create_product',
      'update_product',
      'delete_product',
      'list_locations',
      'adjust_inventory',
    ]);
    expect(catalog.every((a) => a.binding.kind === 'shopify')).toBe(true);
    expect(catalog.find((a) => a.path === 'delete_product')?.risk).toBe('destructive');
  });

  test('ids accept a number or a gid', () => {
    expect(shopifyGid('Order', 42)).toBe('gid://shopify/Order/42');
    expect(shopifyGid('Order', 'gid://shopify/Order/42')).toBe('gid://shopify/Order/42');
    expect(() => shopifyGid('Order', 'abc')).toThrow();
  });
});

describe('calls', () => {
  test('a named action posts its document with the token in X-Shopify-Access-Token', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> = [];
    const result = await executeShopifyCall({
      origin: STORE,
      action: 'list_orders',
      args: { first: 5 },
      token: 'token-1',
      headers: { 'X-Shopify-Access-Token': 'spoofed', Accept: 'text/plain' },
      fetchImpl: fakeFetch({ body: { data: { orders: { nodes: [{ id: 'gid://shopify/Order/1' }], pageInfo: {} } } } }, calls),
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ orders: { nodes: [{ id: 'gid://shopify/Order/1' }], pageInfo: {} } });
    expect(calls[0]!.url).toBe(`${STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(calls[0]!.init.headers['X-Shopify-Access-Token']).toBe('token-1');
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.query).toContain('orders(first: $first');
    expect(body.variables).toEqual({ first: 5, after: null, query: null, reverse: true });
  });

  test('graphql runs the caller document at a chosen version, and checks its input', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> = [];
    const ok = await executeShopifyCall({
      origin: STORE,
      action: 'graphql',
      args: { query: '{ shop { name } }', api_version: '2026-07' },
      token: 't',
      fetchImpl: fakeFetch({ body: { data: { shop: { name: 'Acme' } } } }, calls),
    });
    expect(ok.data).toEqual({ shop: { name: 'Acme' } });
    expect(calls[0]!.url).toContain('/admin/api/2026-07/graphql.json');
    const bad = await executeShopifyCall({ origin: STORE, action: 'graphql', args: { query: '{}', api_version: 'x' }, token: 't', fetchImpl: fakeFetch({ body: {} }) });
    expect(bad).toMatchObject({ ok: false, status: 400 });
  });

  test('adjust_inventory sends an @idempotent key', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchImpl>[1] }> = [];
    await executeShopifyCall({
      origin: STORE,
      action: 'adjust_inventory',
      args: { input: { name: 'available', reason: 'correction', changes: [] }, idempotency_key: 'key-1' },
      token: 't',
      fetchImpl: fakeFetch({ body: { data: { inventoryAdjustQuantities: { userErrors: [] } } } }, calls),
    });
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.query).toContain('@idempotent(key: $idempotencyKey)');
    expect(body.variables.idempotencyKey).toBe('key-1');
  });

  test('protected customer data is protected_data_blocked with the remediation, never an empty list', async () => {
    const result = await executeShopifyCall({
      origin: STORE,
      action: 'list_orders',
      args: {},
      token: 't',
      fetchImpl: fakeFetch({
        body: {
          data: { orders: null },
          errors: [
            {
              message:
                'This app is not approved to access the Order object. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.',
              extensions: { code: 'ACCESS_DENIED' },
              path: ['orders'],
            },
          ],
        },
      }),
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(String(result.data)).toStartWith('protected_data_blocked: the Order object.');
    expect(String(result.data)).toContain(PROTECTED_DATA_REMEDIATION);
  });

  test('a missing scope is scope_missing and names the scope', async () => {
    const result = await executeShopifyCall({
      origin: STORE,
      action: 'list_products',
      args: {},
      token: 't',
      fetchImpl: fakeFetch({
        body: {
          errors: [{ message: 'Access denied for products field. Required access: `read_products` access scope.', extensions: { code: 'ACCESS_DENIED' } }],
        },
      }),
    });
    expect(String(result.data)).toStartWith('scope_missing: read_products.');
  });

  test('a revoked token is reconnect_required; throttling is 429 with a retry time; userErrors are 422', async () => {
    const revoked = await executeShopifyCall({ origin: STORE, action: 'get_shop', args: {}, token: 't', fetchImpl: fakeFetch({ status: 401, body: { errors: '[API] Invalid API key or access token' } }) });
    expect(revoked).toMatchObject({ ok: false, status: 401 });
    expect(String(revoked.data)).toStartWith('reconnect_required');

    const throttled = await executeShopifyCall({
      origin: STORE,
      action: 'get_shop',
      args: {},
      token: 't',
      fetchImpl: fakeFetch({
        body: {
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
          extensions: { cost: { requestedQueryCost: 102, throttleStatus: { currentlyAvailable: 2, restoreRate: 50 } } },
        },
      }),
    });
    expect(throttled).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 2 });

    const invalid = await executeShopifyCall({
      origin: STORE,
      action: 'create_product',
      args: { product: { title: '' } },
      token: 't',
      fetchImpl: fakeFetch({ body: { data: { productCreate: { product: null, userErrors: [{ field: ['title'], message: "Title can't be blank" }] } } } }),
    });
    expect(invalid).toMatchObject({ ok: false, status: 422 });
  });

  test('check_access reports each area as ok, blocked or missing_scope', () => {
    const access = accessFromProbe({
      data: { shop: { name: 'Acme', myshopifyDomain: 'acme.myshopify.com', currencyCode: 'EUR' }, products: { nodes: [] }, orders: null, customers: null, inventoryItems: null },
      errors: [
        { message: 'This app is not approved to access the Order object.', extensions: { code: 'ACCESS_DENIED' }, path: ['orders'] },
        { message: 'This app is not approved to access the Customer object.', extensions: { code: 'ACCESS_DENIED' }, path: ['customers'] },
        { message: 'Access denied for inventoryItems field. Required access: `read_inventory` access scope.', extensions: { code: 'ACCESS_DENIED' }, path: ['inventoryItems'] },
      ],
    });
    expect(access).toEqual({
      shop: { name: 'Acme', domain: 'acme.myshopify.com', currency: 'EUR' },
      catalog: 'ok',
      orders: 'blocked',
      customers: 'blocked',
      inventory: 'missing_scope',
    });
  });
});
