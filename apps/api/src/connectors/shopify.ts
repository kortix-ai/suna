/**
 * The native Shopify connector (`provider: shopify`): the Admin GraphQL API of
 * one store per account, authorized with Shopify's OAuth authorization-code
 * grant.
 *
 * Why not Composio or `provider: graphql`:
 * - Composio's shared Shopify app cannot get protected customer data per store,
 *   so every order call answered ACCESS_DENIED. A custom-distribution app that
 *   the merchant owns can, and its authorization-code grant returns a token
 *   that does not expire.
 * - Shopify disables GraphQL introspection, so `provider: graphql` found 0
 *   actions. This module ships a fixed action set instead: a raw `graphql`
 *   action plus named actions that are a GraphQL document and an input schema.
 *
 * Everything here is pure (no DB). `shopify-connect.ts` runs the OAuth flow and
 * stores the token. The gateway resolves the account's store and calls
 * `executeShopifyCall` through `executeCall`.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { SHOPIFY_SHOP_RE } from '@kortix/manifest-schema';
import type { ExecResult, FetchImpl } from './call';
import type { NormalizedAction, Risk } from './types';

/** The pinned Admin API version. Supported by Shopify until 2027-10-16. */
export const SHOPIFY_API_VERSION = '2026-10';
const API_VERSION_RE = /^(?:\d{4}-(?:01|04|07|10)|unstable)$/;

/** What Connect requests when the connector names no `scopes`. */
export const SHOPIFY_DEFAULT_SCOPES: readonly string[] = [
  'read_orders',
  'write_orders',
  'read_draft_orders',
  'write_draft_orders',
  'read_products',
  'write_products',
  'read_customers',
  'write_customers',
  'read_inventory',
  'write_inventory',
  'read_locations',
];

export const SHOPIFY_TOKEN_HEADER = 'X-Shopify-Access-Token';

/** The connector auth every shopify connector carries: the token in Shopify's header. */
export const SHOPIFY_AUTH = {
  type: 'api_key',
  in: 'header',
  name: SHOPIFY_TOKEN_HEADER,
  prefix: null,
} as const;

// ─── Store names ────────────────────────────────────────────────────────────

/**
 * The store's permanent myshopify.com name (`acme` in `acme.myshopify.com`),
 * from what a person pastes: the name, the host, a store URL, or an admin URL
 * (`admin.shopify.com/store/acme`). `null` for anything else, such as a custom
 * domain, which Shopify's OAuth and Admin API do not answer on.
 */
export function shopifyStoreName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let text = value.trim().toLowerCase();
  if (!text) return null;
  const adminStore = /admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/.exec(text);
  if (adminStore) return adminStore[1]!;
  text = text.replace(/^https?:\/\//, '').split(/[/?#]/)[0]!;
  text = text.replace(/\.myshopify\.com$/, '');
  return /^[a-z0-9][a-z0-9-]{0,59}$/.test(text) ? text : null;
}

/** The canonical `<name>.myshopify.com` host, or `null`. */
export function shopifyShopDomain(value: unknown): string | null {
  const name = shopifyStoreName(value);
  return name ? `${name}.myshopify.com` : null;
}

/** True only for an exact, already-canonical `<name>.myshopify.com` host. */
export function isShopDomain(value: unknown): value is string {
  return typeof value === 'string' && SHOPIFY_SHOP_RE.test(value);
}

/** The store a Shopify app's token URL belongs to (`https://<shop>/admin/oauth/access_token`), or null. */
export function shopifyTokenUrlShop(tokenUrl: unknown): string | null {
  if (typeof tokenUrl !== 'string') return null;
  try {
    const url = new URL(tokenUrl);
    return url.protocol === 'https:' && url.pathname === '/admin/oauth/access_token' && isShopDomain(url.hostname)
      ? url.hostname
      : null;
  } catch {
    return null;
  }
}

/**
 * The origin requests for this store go to. A local stack may point every
 * store at a fake Shopify (`KORTIX_SHOPIFY_STORE_ORIGIN`, honoured only with
 * KORTIX_LOCAL_DEV=1, see config.ts); everywhere else it is `https://<shop>`.
 */
export function shopifyStoreOrigin(shop: string, override?: string | null): string {
  if (!isShopDomain(shop)) throw new Error(`not a Shopify store host: ${shop}`);
  return override ? override.replace(/\/+$/, '') : `https://${shop}`;
}

// ─── OAuth ──────────────────────────────────────────────────────────────────

export function shopifyAuthorizeUrl(input: {
  origin: string;
  clientId: string;
  scopes: readonly string[];
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`${input.origin}/admin/oauth/authorize`);
  url.searchParams.set('client_id', input.clientId);
  // Shopify reads `scope` as a comma-separated list.
  url.searchParams.set('scope', input.scopes.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.href;
}

/**
 * Shopify's callback signature: HMAC-SHA256 (hex) of every query parameter
 * except `hmac`, decoded, sorted by name, joined as `name=value` with `&`,
 * keyed with the app's client secret. Constant-time compare.
 */
export function verifyShopifyHmac(params: URLSearchParams, clientSecret: string): boolean {
  const received = params.get('hmac') ?? '';
  if (!/^[0-9a-f]{64}$/i.test(received) || !clientSecret) return false;
  const message = [...params.entries()]
    .filter(([name]) => name !== 'hmac' && name !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const expected = createHmac('sha256', clientSecret).update(message).digest();
  const given = Buffer.from(received, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ShopifyToken {
  accessToken: string;
  scopes: string[];
  /** Seconds, only for an expiring token. */
  expiresIn?: number;
  refreshToken?: string;
}

/** Shopify's `error` / `error_description` text, kept short and printable. */
function shopifyOAuthError(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const parts = [body.error, body.error_description, body.errors]
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (parts.length) return `HTTP ${status}: ${parts.join(': ').slice(0, 200)}`;
  } catch {
    /* an HTML error page */
  }
  const title = /<title>([^<]{1,200})<\/title>/i.exec(text)?.[1]?.trim();
  return `HTTP ${status}${title ? `: ${title}` : ''}`;
}

/**
 * Redeem the authorization code. `expiring` asks for an expiring offline token
 * (Shopify requires it of new public apps); without it the token does not expire.
 */
export async function exchangeShopifyCode(
  input: {
    origin: string;
    clientId: string;
    clientSecret: string;
    code: string;
    expiring?: boolean;
  },
  fetchImpl: FetchImpl,
): Promise<ShopifyToken> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
  });
  if (input.expiring) body.set('expiring', '1');
  const response = await fetchImpl(`${input.origin}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Shopify token exchange failed (${shopifyOAuthError(response.status, text)})`);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('Shopify token exchange answered no JSON');
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Shopify token exchange answered no access_token');
  }
  return {
    accessToken: payload.access_token,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(',').map((v) => v.trim()).filter(Boolean) : [],
    ...(typeof payload.expires_in === 'number' && payload.expires_in > 0 ? { expiresIn: payload.expires_in } : {}),
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
  };
}

// ─── Actions ────────────────────────────────────────────────────────────────

interface ShopifyActionDef {
  path: string;
  name: string;
  description: string;
  risk: Risk;
  inputSchema: Record<string, unknown>;
  /** The GraphQL document. Absent for `graphql`, which takes the caller's own. */
  document?: string;
  variables?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const MONEY = '{ shopMoney { amount currencyCode } }';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

const LIST_PROPS = {
  first: { type: 'integer', minimum: 1, maximum: 250, default: 25, description: 'Page size (1–250).' },
  after: { type: 'string', description: 'The `pageInfo.endCursor` of the previous page.' },
  query: {
    type: 'string',
    description: "Shopify search syntax, for example `status:open created_at:>2026-01-01`.",
  },
  reverse: { type: 'boolean', description: 'Reverse the sort order. Default: newest first.' },
} as const;

function listVariables(args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? Math.min(250, Math.max(1, Math.trunc(args.first))) : 25;
  return {
    first,
    after: typeof args.after === 'string' && args.after ? args.after : null,
    query: typeof args.query === 'string' && args.query ? args.query : null,
    reverse: typeof args.reverse === 'boolean' ? args.reverse : true,
  };
}

function idVariables(kind: string) {
  return (args: Record<string, unknown>) => ({ id: shopifyGid(kind, args.id) });
}

/** Accept a numeric id or a `gid://shopify/<Kind>/<n>` id. */
export function shopifyGid(kind: string, value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (/^\d+$/.test(text)) return `gid://shopify/${kind}/${text}`;
  if (text.startsWith('gid://shopify/')) return text;
  throw new ShopifyInputError(`id must be a ${kind} id: a number or gid://shopify/${kind}/<number>`);
}

const ID_SCHEMA = (kind: string) => ({
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: ['string', 'integer'], description: `The ${kind} id: a number or gid://shopify/${kind}/<number>.` },
  },
});

const LIST_SCHEMA = { type: 'object', properties: LIST_PROPS };

const OBJECT_INPUT = (name: string, description: string) => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'object', description, additionalProperties: true } },
});

const ACCESS_QUERY = `query CheckAccess {
  shop { name myshopifyDomain currencyCode }
  products(first: 1) { nodes { id } }
  orders(first: 1) { nodes { id } }
  customers(first: 1) { nodes { id } }
  inventoryItems(first: 1) { nodes { id } }
}`;

const ACTIONS: readonly ShopifyActionDef[] = [
  {
    path: 'graphql',
    name: 'GraphQL',
    description:
      'Run any Shopify Admin GraphQL query or mutation against this store. Shopify blocks introspection; use the Admin API reference for the schema.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The GraphQL document.' },
        variables: { type: 'object', additionalProperties: true, description: 'GraphQL variables.' },
        api_version: {
          type: 'string',
          description: `Admin API version, such as ${SHOPIFY_API_VERSION} (the default).`,
        },
      },
    },
  },
  {
    path: 'check_access',
    name: 'Check access',
    description:
      'Report what this account can read: catalog, orders, customers and inventory, each ok, blocked (protected customer data) or missing_scope.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} },
    document: ACCESS_QUERY,
  },
  {
    path: 'get_shop',
    name: 'Get shop',
    description: 'The store name, myshopify.com host, currency, time zone and primary domain.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {} },
    document: 'query GetShop { shop { id name myshopifyDomain currencyCode ianaTimezone primaryDomain { host url } } }',
  },
  {
    path: 'list_orders',
    name: 'List orders',
    description: 'Orders, newest first, with status and total. Needs protected customer data approval.',
    risk: 'read',
    inputSchema: LIST_SCHEMA,
    document: `query ListOrders($first: Int!, $after: String, $query: String, $reverse: Boolean) {
  orders(first: $first, after: $after, query: $query, reverse: $reverse, sortKey: CREATED_AT) {
    nodes { id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus totalPriceSet ${MONEY} customer { id } }
    ${PAGE_INFO}
  }
}`,
    variables: listVariables,
  },
  {
    path: 'get_order',
    name: 'Get order',
    description: 'One order with its line items and totals.',
    risk: 'read',
    inputSchema: ID_SCHEMA('Order'),
    document: `query GetOrder($id: ID!) {
  order(id: $id) {
    id name createdAt updatedAt cancelledAt closedAt note tags displayFinancialStatus displayFulfillmentStatus
    subtotalPriceSet ${MONEY} totalTaxSet ${MONEY} totalPriceSet ${MONEY} customer { id }
    lineItems(first: 100) { nodes { id title quantity sku variant { id } originalUnitPriceSet ${MONEY} } }
  }
}`,
    variables: idVariables('Order'),
  },
  {
    path: 'list_draft_orders',
    name: 'List draft orders',
    description: 'Draft orders, most recently updated first.',
    risk: 'read',
    inputSchema: LIST_SCHEMA,
    document: `query ListDraftOrders($first: Int!, $after: String, $query: String, $reverse: Boolean) {
  draftOrders(first: $first, after: $after, query: $query, reverse: $reverse, sortKey: UPDATED_AT) {
    nodes { id name status createdAt updatedAt invoiceUrl totalPriceSet ${MONEY} }
    ${PAGE_INFO}
  }
}`,
    variables: listVariables,
  },
  {
    path: 'create_draft_order',
    name: 'Create draft order',
    description:
      'Create a draft order. `input` is a Shopify DraftOrderInput, for example {"lineItems":[{"variantId":"gid://shopify/ProductVariant/1","quantity":2}]}.',
    risk: 'write',
    inputSchema: OBJECT_INPUT('input', 'A Shopify DraftOrderInput.'),
    document: `mutation CreateDraftOrder($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id name status invoiceUrl totalPriceSet ${MONEY} }
    userErrors { field message }
  }
}`,
    variables: (args) => ({ input: args.input }),
  },
  {
    path: 'delete_draft_order',
    name: 'Delete draft order',
    description: 'Delete a draft order.',
    risk: 'destructive',
    inputSchema: ID_SCHEMA('DraftOrder'),
    document: `mutation DeleteDraftOrder($id: ID!) {
  draftOrderDelete(input: { id: $id }) { deletedId userErrors { field message } }
}`,
    variables: idVariables('DraftOrder'),
  },
  {
    path: 'list_customers',
    name: 'List customers',
    description: 'Customers, most recently updated first. Needs protected customer data approval.',
    risk: 'read',
    inputSchema: LIST_SCHEMA,
    document: `query ListCustomers($first: Int!, $after: String, $query: String, $reverse: Boolean) {
  customers(first: $first, after: $after, query: $query, reverse: $reverse, sortKey: UPDATED_AT) {
    nodes { id displayName createdAt updatedAt numberOfOrders amountSpent { amount currencyCode } tags }
    ${PAGE_INFO}
  }
}`,
    variables: listVariables,
  },
  {
    path: 'list_products',
    name: 'List products',
    description: 'Products, most recently updated first.',
    risk: 'read',
    inputSchema: LIST_SCHEMA,
    document: `query ListProducts($first: Int!, $after: String, $query: String, $reverse: Boolean) {
  products(first: $first, after: $after, query: $query, reverse: $reverse, sortKey: UPDATED_AT) {
    nodes { id title handle status vendor productType totalInventory createdAt updatedAt }
    ${PAGE_INFO}
  }
}`,
    variables: listVariables,
  },
  {
    path: 'get_product',
    name: 'Get product',
    description: 'One product with its options and variants (price, SKU, inventory item).',
    risk: 'read',
    inputSchema: ID_SCHEMA('Product'),
    document: `query GetProduct($id: ID!) {
  product(id: $id) {
    id title handle status vendor productType tags descriptionHtml totalInventory createdAt updatedAt
    options { id name values }
    variants(first: 100) { nodes { id title sku price inventoryQuantity inventoryItem { id } } }
  }
}`,
    variables: idVariables('Product'),
  },
  {
    path: 'create_product',
    name: 'Create product',
    description:
      'Create a product. `product` is a Shopify ProductCreateInput, for example {"title":"Mug","status":"DRAFT"}.',
    risk: 'write',
    inputSchema: OBJECT_INPUT('product', 'A Shopify ProductCreateInput.'),
    document: `mutation CreateProduct($product: ProductCreateInput!) {
  productCreate(product: $product) { product { id title handle status } userErrors { field message } }
}`,
    variables: (args) => ({ product: args.product }),
  },
  {
    path: 'update_product',
    name: 'Update product',
    description:
      'Update a product. `product` is a Shopify ProductUpdateInput with the product `id`, for example {"id":"gid://shopify/Product/1","title":"Mug"}.',
    risk: 'write',
    inputSchema: OBJECT_INPUT('product', 'A Shopify ProductUpdateInput, including `id`.'),
    document: `mutation UpdateProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id title handle status } userErrors { field message } }
}`,
    variables: (args) => ({ product: args.product }),
  },
  {
    path: 'delete_product',
    name: 'Delete product',
    description: 'Delete a product and its variants.',
    risk: 'destructive',
    inputSchema: ID_SCHEMA('Product'),
    document: `mutation DeleteProduct($id: ID!) {
  productDelete(input: { id: $id }) { deletedProductId userErrors { field message } }
}`,
    variables: idVariables('Product'),
  },
  {
    path: 'list_locations',
    name: 'List locations',
    description: 'Inventory locations, for `adjust_inventory`.',
    risk: 'read',
    inputSchema: { type: 'object', properties: { first: LIST_PROPS.first, after: LIST_PROPS.after } },
    document: `query ListLocations($first: Int!, $after: String) {
  locations(first: $first, after: $after) { nodes { id name isActive } ${PAGE_INFO} }
}`,
    variables: (args) => {
      const { first, after } = listVariables(args);
      return { first, after };
    },
  },
  {
    path: 'adjust_inventory',
    name: 'Adjust inventory',
    description:
      'Change available quantities. `input` is a Shopify InventoryAdjustQuantitiesInput, for example {"name":"available","reason":"correction","changes":[{"delta":-1,"inventoryItemId":"gid://shopify/InventoryItem/1","locationId":"gid://shopify/Location/1","changeFromQuantity":5}]}. Pass `idempotency_key` to make a retry safe.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      required: ['input'],
      properties: {
        input: { type: 'object', additionalProperties: true, description: 'A Shopify InventoryAdjustQuantitiesInput.' },
        idempotency_key: { type: 'string', description: 'Shopify applies one adjustment per key. Default: a new key.' },
      },
    },
    document: `mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { createdAt reason changes { name delta } }
    userErrors { field message }
  }
}`,
    variables: (args) => ({
      input: args.input,
      idempotencyKey:
        typeof args.idempotency_key === 'string' && args.idempotency_key ? args.idempotency_key : randomUUID(),
    }),
  },
];

const ACTION_BY_PATH = new Map(ACTIONS.map((action) => [action.path, action]));

/** The fixed catalog every shopify connector materializes. */
export function shopifyCatalog(): NormalizedAction[] {
  return ACTIONS.map((action) => ({
    path: action.path,
    name: action.name,
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: null,
    risk: action.risk,
    binding: { kind: 'shopify', action: action.path },
  }));
}

export class ShopifyInputError extends Error {}

// ─── Calls ──────────────────────────────────────────────────────────────────

export const PROTECTED_DATA_REMEDIATION =
  'This Shopify app is not approved for protected customer data. In the Shopify Dev Dashboard, give the app Custom distribution for this store, ' +
  'select the order and customer data your agents need under Protected customer data, release a new version, approve it on the store, and connect the account again.';

export const RECONNECT_REQUIRED =
  'reconnect_required: Shopify no longer accepts this account\'s token (the app was uninstalled or its access was revoked). Connect the account again.';

interface GraphqlError {
  message?: unknown;
  path?: unknown;
  extensions?: { code?: unknown; cost?: unknown } & Record<string, unknown>;
}

type AccessVerdict =
  | { kind: 'protected'; object: string | null; message: string }
  | { kind: 'missing_scope'; required: string[]; message: string };

/** Classify one GraphQL error that denies access, or `null` for any other error. */
export function accessVerdict(error: GraphqlError): AccessVerdict | null {
  const message = typeof error.message === 'string' ? error.message : '';
  const code = typeof error.extensions?.code === 'string' ? error.extensions.code : '';
  if (code !== 'ACCESS_DENIED' && !/access denied|not approved to access/i.test(message)) return null;
  const protectedObject = /not approved to access the (\w+) object/i.exec(message);
  if (protectedObject || /protected[- ]customer[- ]data/i.test(message)) {
    return { kind: 'protected', object: protectedObject?.[1] ?? null, message };
  }
  const required = [...message.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).filter((s) => /^(read|write)_/.test(s));
  return { kind: 'missing_scope', required: [...new Set(required)], message };
}

function throttleRetryAfter(errors: GraphqlError[], extensions: Record<string, unknown> | undefined): number | undefined {
  const cost = (extensions?.cost ?? errors.find((e) => e.extensions?.cost)?.extensions?.cost) as
    | { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } }
    | undefined;
  const restoreRate = cost?.throttleStatus?.restoreRate;
  const needed = (cost?.requestedQueryCost ?? 0) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
  if (!restoreRate || restoreRate <= 0) return 1;
  return Math.max(1, Math.ceil(needed / restoreRate));
}

/** Mutation payloads report validation failures in `userErrors`, with HTTP 200. */
function userErrorsOf(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const out: unknown[] = [];
  for (const value of Object.values(data as Record<string, unknown>)) {
    const errors = (value as { userErrors?: unknown } | null)?.userErrors;
    if (Array.isArray(errors)) out.push(...errors);
  }
  return out;
}

export type ShopifyCapability = 'ok' | 'blocked' | 'missing_scope' | 'error';
export interface ShopifyAccess {
  shop: { name: string | null; domain: string | null; currency: string | null };
  catalog: ShopifyCapability;
  orders: ShopifyCapability;
  customers: ShopifyCapability;
  inventory: ShopifyCapability;
}

/** The access matrix the connect stored on an account (`metadata.shopify.access`), or null. */
export function shopifyAccessOf(metadata: unknown): ShopifyAccess | null {
  const access = (metadata as { shopify?: { access?: unknown } } | null)?.shopify?.access as ShopifyAccess | undefined;
  return access && typeof access === 'object' && typeof access.catalog === 'string' ? access : null;
}

const ACCESS_FIELDS = { catalog: 'products', orders: 'orders', customers: 'customers', inventory: 'inventoryItems' } as const;

/** The access matrix from a `check_access` response body. */
export function accessFromProbe(body: unknown): ShopifyAccess {
  const payload = (body ?? {}) as { data?: Record<string, any> | null; errors?: GraphqlError[] };
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const data = payload.data ?? {};
  const capability = (field: string): ShopifyCapability => {
    const fieldErrors = errors.filter((e) => Array.isArray(e.path) && e.path[0] === field);
    for (const error of fieldErrors) {
      const verdict = accessVerdict(error);
      if (verdict?.kind === 'protected') return 'blocked';
      if (verdict?.kind === 'missing_scope') return 'missing_scope';
    }
    if (fieldErrors.length) return 'error';
    return data[field] ? 'ok' : 'error';
  };
  return {
    shop: {
      name: typeof data.shop?.name === 'string' ? data.shop.name : null,
      domain: typeof data.shop?.myshopifyDomain === 'string' ? data.shop.myshopifyDomain : null,
      currency: typeof data.shop?.currencyCode === 'string' ? data.shop.currencyCode : null,
    },
    catalog: capability(ACCESS_FIELDS.catalog),
    orders: capability(ACCESS_FIELDS.orders),
    customers: capability(ACCESS_FIELDS.customers),
    inventory: capability(ACCESS_FIELDS.inventory),
  };
}

/**
 * Map Shopify's answer to the gateway's result. Empty and denied are never the
 * same: an ACCESS_DENIED error fails the call with `protected_data_blocked` or
 * `scope_missing`, even when other fields came back.
 */
export function mapShopifyResponse(result: ExecResult, actionPath: string): ExecResult {
  if (result.status === 401) return { ...result, ok: false, data: RECONNECT_REQUIRED };
  if (result.status === 402) {
    return { ...result, ok: false, data: 'shop_unavailable: Shopify says the store is frozen (unpaid). Its owner resumes the plan in Shopify.' };
  }
  if (result.status === 423) {
    return { ...result, ok: false, data: 'shop_unavailable: Shopify says the store is locked.' };
  }
  if (!result.ok) return result;
  const body = result.data as { data?: unknown; errors?: unknown; extensions?: Record<string, unknown> } | null;
  if (!body || typeof body !== 'object') return result;
  if (typeof body.errors === 'string') return { ...result, ok: false, status: 400, data: { error: 'shopify_error', message: body.errors } };
  const errors = Array.isArray(body.errors) ? (body.errors as GraphqlError[]) : [];
  if (actionPath === 'check_access') {
    return { ...result, data: accessFromProbe(body) };
  }
  if (errors.some((e) => e.extensions?.code === 'THROTTLED')) {
    return {
      ...result,
      ok: false,
      status: 429,
      data: { error: 'shopify_throttled', message: 'Shopify rate-limited this store.', errors },
      retryAfterSeconds: throttleRetryAfter(errors, body.extensions),
    };
  }
  const verdicts = errors.map(accessVerdict).filter((v): v is AccessVerdict => v !== null);
  const protectedVerdict = verdicts.find((v) => v.kind === 'protected');
  // A text reason that starts with its code: the gateway answers it as a 403.
  if (protectedVerdict && protectedVerdict.kind === 'protected') {
    return {
      ...result,
      ok: false,
      status: 403,
      data: `protected_data_blocked: ${protectedVerdict.object ? `the ${protectedVerdict.object} object. ` : ''}${PROTECTED_DATA_REMEDIATION} Shopify: ${protectedVerdict.message}`,
    };
  }
  const scopeVerdict = verdicts.find((v) => v.kind === 'missing_scope');
  if (scopeVerdict && scopeVerdict.kind === 'missing_scope') {
    return {
      ...result,
      ok: false,
      status: 403,
      data:
        `scope_missing: ${scopeVerdict.required.length ? `${scopeVerdict.required.join(', ')}. ` : ''}` +
        'Add the scope to the app version in the Shopify Dev Dashboard, release it, approve it on the store, and connect the account again. ' +
        `Shopify: ${scopeVerdict.message}`,
    };
  }
  if (errors.length && (body.data === null || body.data === undefined)) {
    return { ...result, ok: false, status: 400, data: { error: 'graphql_error', errors } };
  }
  const userErrors = userErrorsOf(body.data);
  if (userErrors.length) {
    return { ...result, ok: false, status: 422, data: { error: 'user_errors', userErrors, data: body.data } };
  }
  // A partial answer keeps its errors next to the data.
  return { ...result, data: errors.length ? { data: body.data, errors } : body.data };
}

/** Build and run one Shopify Admin GraphQL request. */
export async function executeShopifyCall(input: {
  origin: string;
  action: string;
  args: Record<string, unknown>;
  token: string | null;
  headers?: Record<string, string> | null;
  fetchImpl: FetchImpl;
}): Promise<ExecResult> {
  const action = ACTION_BY_PATH.get(input.action);
  if (!action) return { status: 404, ok: false, data: `shopify action not found: ${input.action}` };
  if (!input.token) return { status: 401, ok: false, data: RECONNECT_REQUIRED };
  let query: string;
  let variables: Record<string, unknown>;
  let apiVersion = SHOPIFY_API_VERSION;
  try {
    if (action.path === 'graphql') {
      if (typeof input.args.query !== 'string' || !input.args.query.trim()) {
        throw new ShopifyInputError('query is required');
      }
      query = input.args.query;
      const raw = input.args.variables;
      if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        throw new ShopifyInputError('variables must be an object');
      }
      variables = (raw as Record<string, unknown> | undefined) ?? {};
      if (input.args.api_version !== undefined) {
        if (typeof input.args.api_version !== 'string' || !API_VERSION_RE.test(input.args.api_version)) {
          throw new ShopifyInputError('api_version must look like 2026-10');
        }
        apiVersion = input.args.api_version;
      }
    } else {
      query = action.document!;
      variables = action.variables?.(input.args) ?? {};
    }
  } catch (error) {
    if (error instanceof ShopifyInputError) return { status: 400, ok: false, data: { error: 'invalid_input', message: error.message } };
    throw error;
  }
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).filter(([name]) => name.toLowerCase() !== SHOPIFY_TOKEN_HEADER.toLowerCase()),
    ),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    [SHOPIFY_TOKEN_HEADER]: input.token,
  };
  const response = await input.fetchImpl(`${input.origin}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body (an HTML error page) stays text */
  }
  const retryAfter = response.headers?.get('retry-after');
  const result: ExecResult = {
    status: response.status,
    ok: response.ok,
    data,
    ...(!response.ok && retryAfter && /^\d+$/.test(retryAfter) ? { retryAfterSeconds: Number(retryAfter) } : {}),
  };
  return mapShopifyResponse(result, action.path);
}
