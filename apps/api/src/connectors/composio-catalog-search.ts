import ComposioClient from '@composio/client';

interface CatalogToolkit {
  slug: string;
  name: string;
  no_auth?: boolean;
  meta: {
    logo?: string | null;
    description?: string | null;
    categories?: Array<{ id: string; name: string }>;
  };
}

export interface ComposioCatalogClient {
  toolkits: {
    list(query: { limit: number; sort_by: 'usage'; cursor?: string }): Promise<{
      items: CatalogToolkit[];
      next_cursor?: string | null;
    }>;
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

/** Composio rejects searches shorter than three characters. Search its complete
 * public catalogue here; session toolkits omit descriptions and connection data
 * must never enter this deployment-wide cache. */
export async function searchComposioCatalog(input: {
  q: string;
  cursor?: string;
  limit?: number;
  catalogClient?: ComposioCatalogClient;
}) {
  const catalogClient =
    input.catalogClient ??
    (client ??= new ComposioClient({
      apiKey: process.env.COMPOSIO_API_KEY,
    }));
  const catalog = await catalogSnapshot(catalogClient);
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
    toolkits: matches.slice(offset, nextOffset).map((item) => ({
      slug: item.slug,
      name: item.name,
      logo: item.meta.logo ?? null,
      description: item.meta.description ?? null,
      categories: (item.meta.categories ?? []).map((category) => category.id),
      isNoAuth: item.no_auth === true,
      connected: false,
    })),
    total: matches.length,
    ...(hasMore ? { nextCursor: Buffer.from(String(nextOffset)).toString('base64url') } : {}),
    hasMore,
  };
}
