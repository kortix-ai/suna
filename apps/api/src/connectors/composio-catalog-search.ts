import ComposioClient from '@composio/client';

interface CatalogToolkit {
  slug: string;
  name: string;
  no_auth?: boolean;
  /** Every scheme the toolkit accepts: `OAUTH2`, `API_KEY`, ... */
  auth_schemes?: string[] | null;
  /** The schemes Composio holds its own app for. Empty means bring your own. */
  composio_managed_auth_schemes?: string[] | null;
  meta: {
    logo?: string | null;
    description?: string | null;
    categories?: Array<{ id: string; name: string }>;
  };
}

interface AuthConfigRow {
  id: string;
  status: 'ENABLED' | 'DISABLED';
  is_composio_managed?: boolean;
  toolkit: { slug: string };
  created_at?: string;
}

export interface ComposioCatalogClient {
  toolkits: {
    list(query: { limit: number; sort_by: 'usage'; cursor?: string }): Promise<{
      items: CatalogToolkit[];
      next_cursor?: string | null;
    }>;
  };
  authConfigs?: {
    list(query: {
      toolkit_slug?: string;
      is_composio_managed: false;
      show_disabled: false;
      limit: number;
      cursor?: string;
    }): Promise<{ items: AuthConfigRow[]; next_cursor?: string | null }>;
  };
}

const CATALOG_TTL_MS = 6 * 60 * 60_000;
let client: ComposioCatalogClient | undefined;
const cache = new WeakMap<
  ComposioCatalogClient,
  { at: number; snapshot: Promise<CatalogToolkit[]> }
>();

async function loadCatalog(client: ComposioCatalogClient): Promise<CatalogToolkit[]> {
  const items = new Map<string, CatalogToolkit>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.toolkits.list({
      limit: 1000,
      sort_by: 'usage',
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      const slug = item.slug.toLowerCase();
      if (!items.has(slug)) items.set(slug, item);
    }
    cursor = page.next_cursor?.trim() || undefined;
    if (cursor && cursors.has(cursor))
      throw new Error('Composio toolkit catalogue repeated a cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...items.values()];
}

async function catalogSnapshot(client: ComposioCatalogClient): Promise<CatalogToolkit[]> {
  const cached = cache.get(client);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.snapshot;
  const entry = { at: Date.now(), snapshot: loadCatalog(client) };
  cache.set(client, entry);
  try {
    return await entry.snapshot;
  } catch (error) {
    // An expired request can fail after a newer load replaces its cache entry.
    if (cache.get(client) === entry) cache.delete(client);
    throw error;
  }
}

function offsetFromCursor(cursor?: string): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = Number(decoded);
  return /^\d+$/.test(decoded) && Number.isSafeInteger(offset) ? offset : 0;
}

/** The deployment's REST client for the raw catalogue and auth config lists. */
export function composioRestClient(): ComposioCatalogClient {
  return (client ??= new ComposioClient({
    apiKey: process.env.COMPOSIO_API_KEY,
  }));
}

/**
 * True when Composio cannot connect the toolkit with its own OAuth app, so the
 * project must hold an auth config with the operator's app.
 *
 * Composio removed its X (`twitter`) app on 2026-02-12, and 46 other toolkits
 * (`xero`, `spotify`, `google_chat`, ...) never had one. Tool Router refuses a
 * session for them with 400 code 4300 ("require auth configs but none exist and
 * cannot be auto-created") and does not pick up a custom config on its own.
 * API-key and mixed-scheme toolkits are not affected: Tool Router creates their
 * config itself. Live check on 2026-09-26: this rule selected 47 toolkits and
 * Composio refused all 47; it refused 0 of 25 sampled other toolkits.
 */
export function requiresOwnAuthConfig(
  item: Pick<CatalogToolkit, 'no_auth' | 'auth_schemes' | 'composio_managed_auth_schemes'>,
): boolean {
  if (item.no_auth) return false;
  if ((item.composio_managed_auth_schemes ?? []).length > 0) return false;
  const schemes = item.auth_schemes ?? [];
  return schemes.length > 0 && schemes.every((scheme) => scheme.startsWith('OAUTH'));
}

/**
 * Toolkit slug to the enabled custom auth config Kortix passes for it. When an
 * operator keeps more than one enabled, the newest wins; disable the old one to
 * rotate an OAuth app. Composio-managed and disabled configs are never used.
 */
export async function customAuthConfigIds(input: {
  catalogClient?: ComposioCatalogClient;
  toolkit?: string;
} = {}): Promise<Map<string, string>> {
  const authConfigs = (input.catalogClient ?? composioRestClient()).authConfigs;
  if (!authConfigs) throw new Error('Composio auth config API is unavailable');
  const newest = new Map<string, AuthConfigRow>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await authConfigs.list({
      ...(input.toolkit ? { toolkit_slug: input.toolkit.toLowerCase() } : {}),
      is_composio_managed: false,
      show_disabled: false,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const row of page.items) {
      if (row.status !== 'ENABLED' || row.is_composio_managed !== false) continue;
      const slug = row.toolkit.slug.toLowerCase();
      const current = newest.get(slug);
      if (!current || (row.created_at ?? '') > (current.created_at ?? '')) newest.set(slug, row);
    }
    cursor = page.next_cursor?.trim() || undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Composio auth config list repeated a cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return new Map([...newest].map(([slug, row]) => [slug, row.id]));
}

// Short, so an auth config an operator just created shows its toolkit within a
// minute. The connect path never reads this cache.
const AUTH_CONFIG_TTL_MS = 60_000;
const authConfigCache = new WeakMap<
  ComposioCatalogClient,
  { at: number; ids: Promise<Map<string, string>> }
>();

async function cachedCustomAuthConfigIds(catalogClient: ComposioCatalogClient) {
  const cached = authConfigCache.get(catalogClient);
  if (cached && Date.now() - cached.at < AUTH_CONFIG_TTL_MS) return cached.ids;
  const entry = { at: Date.now(), ids: customAuthConfigIds({ catalogClient }) };
  authConfigCache.set(catalogClient, entry);
  try {
    return await entry.ids;
  } catch (error) {
    if (authConfigCache.get(catalogClient) === entry) authConfigCache.delete(catalogClient);
    throw error;
  }
}

/**
 * The toolkits every catalogue view leaves out: those Composio cannot connect
 * and that have no auth config yet. Adding one only produced a 4300 on sync.
 * Fails open: when either list is unavailable nothing is hidden, and connecting
 * such a toolkit still answers a clear 422.
 */
async function hiddenToolkits(
  catalogClient: ComposioCatalogClient,
  catalog: CatalogToolkit[],
): Promise<Set<string>> {
  const needy = catalog.filter(requiresOwnAuthConfig).map((item) => item.slug.toLowerCase());
  if (needy.length === 0 || !catalogClient.authConfigs) return new Set();
  try {
    const configured = await cachedCustomAuthConfigIds(catalogClient);
    return new Set(needy.filter((slug) => !configured.has(slug)));
  } catch (error) {
    console.warn('[composio] auth config list unavailable, hiding no toolkits:', error);
    return new Set();
  }
}

export async function composioHiddenToolkits(
  catalogClient: ComposioCatalogClient = composioRestClient(),
): Promise<Set<string>> {
  try {
    return await hiddenToolkits(catalogClient, await catalogSnapshot(catalogClient));
  } catch (error) {
    console.warn('[composio] toolkit catalogue unavailable, hiding no toolkits:', error);
    return new Set();
  }
}

async function visibleCatalog(catalogClient: ComposioCatalogClient): Promise<CatalogToolkit[]> {
  const catalog = await catalogSnapshot(catalogClient);
  const hidden = await hiddenToolkits(catalogClient, catalog);
  return hidden.size === 0 ? catalog : catalog.filter((item) => !hidden.has(item.slug.toLowerCase()));
}

/** The public card shape. `connected` is always false: connection state is
 *  per project and must never enter this deployment-wide cache. */
function publicToolkit(item: CatalogToolkit) {
  return {
    slug: item.slug,
    name: item.name,
    logo: item.meta.logo ?? null,
    description: item.meta.description ?? null,
    categories: (item.meta.categories ?? []).map((category) => category.id),
    isNoAuth: item.no_auth === true,
    connected: false,
  };
}

function boundedCount(value: number | undefined, fallback: number, max: number): number {
  return value && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

/**
 * The browse page: the top `perCategory` toolkits of each of the largest
 * categories, each with the category's TRUE size, in one request.
 *
 * The client used to bucket one 48-toolkit page by category and label each
 * bucket with its own length. The catalogue has ~1500 toolkits across ~90
 * categories, so most headings read `· 1` over a category that holds dozens.
 * Grouping the complete snapshot fixes the count at the source.
 *
 * The keys are Composio's category ids, which equal the slugs its
 * `toolkits.get({ category })` filter accepts — so a section's `total` is the
 * size of the grid its "View all" opens. Within a section toolkits keep the
 * snapshot's usage order. Limits and defaults match `pipedreamCatalogSections`.
 */
export async function composioCatalogSections(input: {
  perCategory?: number;
  maxCategories?: number;
  catalogClient?: ComposioCatalogClient;
}) {
  const perCategory = boundedCount(input.perCategory, 6, 24);
  const maxCategories = boundedCount(input.maxCategories, 12, 40);
  const catalog = await visibleCatalog(input.catalogClient ?? composioRestClient());

  const byCategory = new Map<string, { label: string; items: CatalogToolkit[] }>();
  for (const item of catalog) {
    const seen = new Set<string>();
    for (const category of item.meta.categories ?? []) {
      const key = category.id.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const bucket = byCategory.get(key);
      if (bucket) bucket.items.push(item);
      else byCategory.set(key, { label: category.name?.trim() || key, items: [item] });
    }
  }

  const categories = [...byCategory.entries()]
    .map(([key, bucket]) => ({ key, label: bucket.label, count: bucket.items.length }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    provider: 'composio' as const,
    sections: categories.slice(0, maxCategories).map((category) => ({
      key: category.key,
      label: category.label,
      total: category.count,
      toolkits: byCategory.get(category.key)!.items.slice(0, perCategory).map(publicToolkit),
    })),
    categories,
  };
}

/** Composio rejects searches shorter than three characters. Search its complete
 * public catalogue here; session toolkits omit descriptions and connection data
 * must never enter this deployment-wide cache. */
export async function searchComposioCatalog(input: {
  q: string;
  cursor?: string;
  limit?: number;
  catalogClient?: ComposioCatalogClient;
}) {
  const catalog = await visibleCatalog(input.catalogClient ?? composioRestClient());
  const query = input.q.trim().toLowerCase();
  const matches = catalog.filter((item) =>
    `${item.name} ${item.slug} ${item.meta.description ?? ''}`.toLowerCase().includes(query),
  );
  const limit = Math.min(Math.max(input.limit ?? 48, 1), 100);
  const offset = Math.min(offsetFromCursor(input.cursor), matches.length);
  const nextOffset = offset + limit;
  const hasMore = nextOffset < matches.length;
  return {
    provider: 'composio' as const,
    toolkits: matches.slice(offset, nextOffset).map(publicToolkit),
    total: matches.length,
    ...(hasMore ? { nextCursor: Buffer.from(String(nextOffset)).toString('base64url') } : {}),
    hasMore,
  };
}
