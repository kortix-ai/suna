import { appNameKey } from './connect-direct-twins';
import {
  groupIntoSections,
  sectionKeysForEntry,
  sectionTitle,
  sortByPicks,
} from '@kortix/shared/connector-sections';
import { logger } from '../lib/logger';
import oneClickMcp from './one-click-mcp.json';

/** MCP endpoints a client connects to with the URL alone, from the last
 *  `scripts/probe-one-click-mcp.ts` run. */
const ONE_CLICK_MCP: ReadonlySet<string> = new Set(Object.keys(oneClickMcp.servers));

const INTEGRATIONS_BASE_URL = 'https://integrations.sh';
const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 48;
const MAX_PAGE_SIZE = 96;

/** A non-2xx from integrations.sh. `status` lets callers separate "no such
 *  record" (404) from an outage (everything else). */
class UpstreamStatusError extends Error {
  status: number;
  constructor(status: number) {
    super(`integrations.sh returned ${status}`);
    this.status = status;
  }
}

const OFFICIAL_SURFACE_ENRICHMENTS: Record<string, ConnectorSurfaceVariant[]> = {
  'hubspot.com': [
    {
      id: 'hubspot-public-api-postman',
      kind: 'postman',
      name: 'HubSpot Public API Collection',
      url: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
      docs: 'https://developers.hubspot.com/docs/api-reference/latest/overview',
      description: "HubSpot's official public Postman API repository.",
      transports: [],
      requiresAuth: true,
      command: null,
      connector: {
        provider: 'postman',
        spec: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
        auth: {
          type: 'bearer',
          in: 'header',
          name: 'Authorization',
          prefix: 'Bearer',
        },
      },
    },
  ],
};

/** `composio`: a managed Composio toolkit (`connectors_v2` catalogue only). */
export type ConnectorCatalogKind = 'openapi' | 'mcp' | 'graphql' | 'cli' | 'composio';

/** A Composio toolkit as the managed catalogue routes publish it. */
export interface ComposioCatalogCard {
  slug: string;
  name: string;
  logo: string | null;
  description: string | null;
  categories: string[];
  isNoAuth: boolean;
  connected: boolean;
}

export interface ConnectorCatalogItem {
  id: string;
  kind: ConnectorCatalogKind;
  slug: string;
  name: string;
  description: string | null;
  url: string | null;
  icon: string | null;
  domain: string;
  categories: string[];
  feeds: string[];
  popularity: number | null;
  /** The hosted MCP server (`connectUrl`), https only. MCP entries only. */
  mcpUrl?: string;
  /** The index's curated, OAuth-signed-in servers rank first. */
  oauth?: boolean;
  /** Connects with nothing to set up: a public or self-registering MCP server
   *  (`one-click-mcp.json`), a Kortix catalogue app, or a managed toolkit. */
  oneClick?: boolean;
  /** The toolkit a `composio` record installs. */
  composio?: ComposioCatalogCard;
}

export interface ConnectorTemplate {
  provider: 'openapi' | 'postman' | 'mcp' | 'graphql';
  spec?: string;
  url?: string;
  transport?: 'http' | 'sse';
  endpoint?: string;
  auth?: {
    type: 'none' | 'bearer' | 'basic' | 'custom';
    in: 'header' | 'query';
    name: string | null;
    prefix: string | null;
  };
}

export interface ConnectorSurfaceVariant {
  id: string;
  kind: 'openapi' | 'postman' | 'mcp' | 'graphql' | 'http' | 'cli';
  name: string;
  url: string | null;
  docs: string | null;
  description: string | null;
  transports: string[];
  requiresAuth: boolean;
  command: string | null;
  connector: ConnectorTemplate | null;
}

export interface ConnectorCatalogDetail {
  item: ConnectorCatalogItem;
  variants: ConnectorSurfaceVariant[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CatalogOptions {
  fetch?: FetchLike;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** A catalogue other than integrations.sh, held in memory: its records and
   *  each domain's surfaces, served as they are (no fetch, no enrichment). */
  source?: {
    items(): ConnectorCatalogItem[] | Promise<ConnectorCatalogItem[]>;
    surfaces(domain: string): ConnectorSurfaceVariant[] | Promise<ConnectorSurfaceVariant[]>;
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeItem(value: unknown): ConnectorCatalogItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== 'openapi' && kind !== 'mcp' && kind !== 'graphql' && kind !== 'cli') return null;
  const id = nullableString(raw.id);
  const slug = nullableString(raw.slug);
  const name = nullableString(raw.name);
  const domain = nullableString(raw.domain);
  if (!id || !slug || !name || !domain) return null;
  return {
    id,
    kind,
    slug,
    name,
    description: nullableString(raw.description),
    url: nullableString(raw.url),
    icon: nullableString(raw.icon),
    domain,
    categories: strings(raw.categories),
    feeds: strings(raw.feeds),
    popularity:
      typeof raw.popularity === 'number' && Number.isFinite(raw.popularity) ? raw.popularity : null,
    ...(kind === 'mcp' && httpsUrl(raw.connectUrl) ? { mcpUrl: httpsUrl(raw.connectUrl)! } : {}),
    ...((raw.auth as { kind?: unknown } | undefined)?.kind === 'oauth' ? { oauth: true } : {}),
    ...(kind === 'mcp' && ONE_CLICK_MCP.has(String(raw.connectUrl).trim()) ? { oneClick: true } : {}),
  };
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function authTemplate(surface: Record<string, unknown>): ConnectorTemplate['auth'] | undefined {
  const auth = surface.auth as Record<string, unknown> | undefined;
  if (!auth || auth.status === 'none' || auth.status === 'optional') return undefined;
  if (auth.status !== 'required') return undefined;

  const entries = Array.isArray(auth.entries) ? auth.entries : [];
  for (const entry of entries) {
    const uses = Array.isArray((entry as Record<string, unknown>)?.use)
      ? ((entry as Record<string, unknown>).use as unknown[])
      : [];
    for (const use of uses) {
      const mechanics = (use as Record<string, unknown>)?.mechanics as
        Record<string, unknown> | undefined;
      if (!mechanics) continue;
      const scheme = nullableString(mechanics.scheme)?.toLowerCase();
      const headerName = nullableString(mechanics.headerName);
      const paramName = nullableString(mechanics.paramName);
      if (scheme === 'basic') {
        return {
          type: 'basic',
          in: 'header',
          name: 'Authorization',
          prefix: 'Basic',
        };
      }
      if (scheme === 'bearer' || headerName?.toLowerCase() === 'authorization') {
        return {
          type: 'bearer',
          in: 'header',
          name: headerName ?? 'Authorization',
          prefix: 'Bearer',
        };
      }
      if (headerName) {
        return { type: 'custom', in: 'header', name: headerName, prefix: null };
      }
      if (paramName) {
        return { type: 'custom', in: 'query', name: paramName, prefix: null };
      }
    }
  }

  // OAuth/well-known remote MCPs still present a bearer token to the connector
  // runtime after authorization. Kortix does not pretend this is automatic.
  return {
    type: 'bearer',
    in: 'header',
    name: 'Authorization',
    prefix: 'Bearer',
  };
}

function normalizeSurface(value: unknown, index: number): ConnectorSurfaceVariant | null {
  if (!value || typeof value !== 'object') return null;
  const surface = value as Record<string, unknown>;
  const type = nullableString(surface.type);
  const name = nullableString(surface.name) ?? `Surface ${index + 1}`;
  const slug = nullableString(surface.slug) ?? `surface-${index + 1}`;
  const url = nullableString(surface.url);
  const docs = nullableString(surface.docs);
  const spec = nullableString(surface.spec);
  const transports = strings(surface.transports);
  const requiresAuth = (surface.auth as Record<string, unknown> | undefined)?.status === 'required';
  const auth = authTemplate(surface);
  const withAuth = <T extends ConnectorTemplate>(connector: T): T =>
    auth ? { ...connector, auth } : connector;

  if (type === 'http') {
    if (spec) {
      return {
        id: slug,
        kind: 'openapi',
        name,
        url,
        docs,
        description: null,
        transports,
        requiresAuth,
        command: null,
        connector: withAuth({ provider: 'openapi', spec }),
      };
    }
    return {
      id: slug,
      kind: 'http',
      name,
      url,
      docs,
      description: null,
      transports,
      requiresAuth,
      command: null,
      connector: null,
    };
  }
  if (type === 'mcp') {
    const transport: 'http' | 'sse' = transports.includes('streamable-http') ? 'http' : 'sse';
    return {
      id: slug,
      kind: 'mcp',
      name,
      url,
      docs,
      description: null,
      transports,
      requiresAuth,
      command: null,
      connector: url ? withAuth({ provider: 'mcp', url, transport }) : null,
    };
  }
  if (type === 'graphql') {
    return {
      id: slug,
      kind: 'graphql',
      name,
      url,
      docs,
      description: null,
      transports,
      requiresAuth,
      command: null,
      connector: url ? withAuth({ provider: 'graphql', endpoint: url }) : null,
    };
  }
  if (type === 'cli') {
    return {
      id: slug,
      kind: 'cli',
      name,
      url,
      docs,
      description: null,
      transports,
      requiresAuth,
      command: nullableString(surface.command),
      connector: null,
    };
  }
  if (type === 'postman') {
    const source = spec ?? url;
    return {
      id: slug,
      kind: 'postman',
      name,
      url,
      docs,
      description: null,
      transports,
      requiresAuth,
      command: null,
      connector: source ? withAuth({ provider: 'postman', spec: source }) : null,
    };
  }
  return null;
}

function boundedCount(value: number | undefined, fallback: number, max: number): number {
  return value && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

/** How many apps (domains) a set of records covers: what a list of it shows. */
function appCount(items: ConnectorCatalogItem[]): number {
  return new Set(items.map((item) => item.domain)).size;
}

/** The surface an app's card stands for: a one-click MCP server, then a
 *  managed toolkit, then any MCP server, then the APIs. */
const SURFACE_RANK: Record<ConnectorCatalogKind, number> = {
  composio: 1,
  mcp: 2,
  openapi: 3,
  graphql: 4,
  cli: 5,
};
const surfaceRank = (item: ConnectorCatalogItem) =>
  item.kind === 'mcp' && item.oneClick ? 0 : SURFACE_RANK[item.kind];

/**
 * One record per app (domain), at the position of the app's first record, and
 * represented by its best surface.
 */
function onePerApp(items: ConnectorCatalogItem[]): ConnectorCatalogItem[] {
  const order: string[] = [];
  const best = new Map<string, ConnectorCatalogItem>();
  for (const item of items) {
    const current = best.get(item.domain);
    if (!current) {
      order.push(item.domain);
      best.set(item.domain, item);
    } else if (surfaceRank(item) < surfaceRank(current)) {
      best.set(item.domain, item);
    }
  }
  return order.map((domain) => best.get(domain)!);
}

/**
 * Search results by how well the NAME matches: exact, then prefix, then the
 * domain, then any other field. Stable inside each tier, so the index order
 * (popularity) breaks ties.
 */
function rankByName(items: ConnectorCatalogItem[], query: string): ConnectorCatalogItem[] {
  const tier = (item: ConnectorCatalogItem) => {
    const name = item.name.toLowerCase();
    if (name === query) return 0;
    if (name.startsWith(query)) return 1;
    if (item.domain.toLowerCase().startsWith(query)) return 2;
    if (name.includes(query)) return 3;
    return 4;
  };
  return items
    .map((item, index) => ({ item, index, rank: tier(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

/** With `oneClick`, only the records that connect with nothing to set up. */
const oneClickOnly = (items: ConnectorCatalogItem[], oneClick?: boolean) =>
  oneClick ? items.filter((item) => item.oneClick) : items;

export function createConnectorCatalog(options: CatalogOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let indexCache: { items: ConnectorCatalogItem[]; at: number } | null = null;
  let indexRequest: Promise<ConnectorCatalogItem[]> | null = null;
  const surfaceCache = new Map<string, { value: ConnectorSurfaceVariant[]; at: number }>();
  const surfaceRequests = new Map<string, Promise<ConnectorSurfaceVariant[]>>();

  const fetchJson = async (url: string): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new UpstreamStatusError(response.status);
      return await response.json();
    } catch (error) {
      // A catalogue failure reaches the route as a bare 502 body; this warn is
      // the only server-side record of which upstream call failed and why.
      logger.warn('[connector-catalog] integrations.sh request failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const loadIndex = async (): Promise<ConnectorCatalogItem[]> => {
    if (options.source) return options.source.items();
    if (indexCache && now() - indexCache.at < ttlMs) return indexCache.items;
    if (indexRequest) return indexRequest;
    indexRequest = (async () => {
      try {
        const body = (await fetchJson(`${INTEGRATIONS_BASE_URL}/api.json`)) as Record<
          string,
          unknown
        >;
        if (!body || !Array.isArray(body.data))
          throw new Error('integrations.sh returned an invalid catalogue');
        const items = body.data
          .map(normalizeItem)
          .filter((item): item is ConnectorCatalogItem => item !== null);
        if (items.length === 0) throw new Error('integrations.sh returned an empty catalogue');
        indexCache = { items, at: now() };
        return items;
      } catch (error) {
        if (indexCache) return indexCache.items;
        throw error;
      } finally {
        indexRequest = null;
      }
    })();
    return indexRequest;
  };

  const loadSurfaces = async (domain: string): Promise<ConnectorSurfaceVariant[]> => {
    if (options.source) return options.source.surfaces(domain);
    const cached = surfaceCache.get(domain);
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const pending = surfaceRequests.get(domain);
    if (pending) return pending;
    const request = (async () => {
      try {
        const body = (await fetchJson(
          `${INTEGRATIONS_BASE_URL}/api/${encodeURIComponent(domain)}/surface`,
        )) as Record<string, unknown>;
        if (!body || !Array.isArray(body.surfaces))
          throw new Error('integrations.sh returned an invalid surface');
        const variants = body.surfaces
          .map(normalizeSurface)
          .filter((variant): variant is ConnectorSurfaceVariant => variant !== null);
        surfaceCache.set(domain, { value: variants, at: now() });
        return variants;
      } catch (error) {
        if (cached) return cached.value;
        if (error instanceof UpstreamStatusError && error.status === 404) {
          // integrations.sh has no surface page for this domain (the apis-guru
          // feed lists pseudo-domains like `whatsapp.local`). That is an empty
          // catalogue record, not an outage: serve the item with no surfaces
          // and cache it, so a detail view neither 502s nor refetches.
          surfaceCache.set(domain, { value: [], at: now() });
          return [];
        }
        throw error;
      } finally {
        surfaceRequests.delete(domain);
      }
    })();
    surfaceRequests.set(domain, request);
    return request;
  };

  return {
    /** Every record, one per surface, unpaged. */
    items: loadIndex,
    /** One domain's surfaces. */
    surfaces: loadSurfaces,
    /**
     * A page of the catalogue. `category` is a browse-section key from
     * `sections()` — membership uses the same shared rule that built the
     * section, and picks lead in the same order, so "View all" opens exactly
     * the set and order the section heading counted.
     */
    async list(
      input: { q?: string; cursor?: string; limit?: number; category?: string; oneClick?: boolean } = {},
    ) {
      const items = oneClickOnly(await loadIndex(), input.oneClick);
      const query = input.q?.trim().toLowerCase() ?? '';
      const category = input.category?.trim();
      const searched = query
        ? items.filter((item) =>
            [item.name, item.description, item.domain, item.kind, ...item.categories]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(query)),
          )
        : items;
      const scoped = category
        ? sortByPicks(
            category,
            searched.filter((item) => sectionKeysForEntry(item.categories).has(category)),
          )
        : query
          ? rankByName(searched, query)
          : searched;
      // The feed has one record per surface (MCP, OpenAPI, CLI). A card is an
      // app: its page lists every surface, so a list shows each app once.
      const filtered = onePerApp(scoped);
      const parsedOffset = Number.parseInt(input.cursor ?? '0', 10);
      const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
      const limit = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Math.floor(input.limit ?? DEFAULT_PAGE_SIZE)),
      );
      const page = filtered.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        items: page,
        total: filtered.length,
        nextCursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
        hasMore: nextOffset < filtered.length,
      };
    },

    /**
     * The browse page: Popular, then a fixed top slice of each section, each
     * with the section's TRUE size across the complete catalogue.
     *
     * The web page used to bucket one 48-item page of ~5500 and head each
     * bucket with its card count, so most headings read `· 1`. Grouping the
     * whole index here fixes the count at the source. Sections follow the
     * shared curated order; limits and defaults match the other providers.
     */
    async sections(input: { perCategory?: number; maxCategories?: number; oneClick?: boolean } = {}) {
      const perCategory = boundedCount(input.perCategory, 6, 24);
      const maxCategories = boundedCount(input.maxCategories, 12, 40);
      const items = oneClickOnly(await loadIndex(), input.oneClick);
      const groups = groupIntoSections(items, (item) => item.categories);
      // The feed publishes one record per surface (`stripe-com`,
      // `stripe-com-openapi`, `stripe-com-cli`). A card resolves every surface
      // for its domain, so a slice shows one card per domain. `total` counts
      // apps (domains), because \"View all\" (`list`) shows each app once.
      const onePerDomain = (candidates: ConnectorCatalogItem[]) => {
        const seen = new Set<string>();
        const distinct: ConnectorCatalogItem[] = [];
        for (const item of candidates) {
          if (seen.has(item.domain)) continue;
          seen.add(item.domain);
          distinct.push(item);
          if (distinct.length === perCategory) break;
        }
        return distinct;
      };
      const popular = onePerDomain(
        items
          .filter((item) => item.popularity !== null)
          .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)),
      );
      return {
        popular,
        sections: groups.slice(0, maxCategories).map((group) => ({
          key: group.category,
          label: sectionTitle(group.category),
          total: appCount(group.items),
          items: onePerDomain(sortByPicks(group.category, group.items)),
        })),
        categories: groups.map((group) => ({
          key: group.category,
          label: sectionTitle(group.category),
          count: appCount(group.items),
        })),
      };
    },

    /**
     * Icon lookups across the whole index, keyed by domain and by app name.
     * A connector that stores no icon shows the icon of the domain that owns
     * the host it calls, else the icon of the app it is named after
     * (`connector-icon.ts`). Keys are lower case; the first record wins.
     */
    async icons(): Promise<{ byDomain: Map<string, string>; byName: Map<string, string> }> {
      const byDomain = new Map<string, string>();
      const byName = new Map<string, string>();
      for (const item of await loadIndex()) {
        if (!item.icon) continue;
        const domain = item.domain.toLowerCase();
        const name = item.name.toLowerCase();
        if (!byDomain.has(domain)) byDomain.set(domain, item.icon);
        if (!byName.has(name)) byName.set(name, item.icon);
      }
      return { byDomain, byName };
    },

    /**
     * Each app's catalogue id by its join key (`appNameKey`), its MCP surface
     * first. Managed listings use it to name the same app's API/MCP entry.
     */
    async directIds(): Promise<Map<string, string>> {
      const best = new Map<string, ConnectorCatalogItem>();
      for (const item of await loadIndex()) {
        const key = appNameKey(item.name);
        const current = best.get(key);
        if (!current || surfaceRank(item) < surfaceRank(current)) best.set(key, item);
      }
      return new Map([...best].map(([key, item]) => [key, item.id]));
    },

    /**
     * Each app's hosted MCP server URL by its join key: a curated OAuth entry
     * first, then the most popular. Install offers it before the managed app.
     */
    async directMcpUrls(): Promise<Map<string, string>> {
      const rank = (item: ConnectorCatalogItem) =>
        (item.oneClick ? 4 : 0) + (item.feeds.includes('curated') ? 2 : 0) + (item.oauth ? 1 : 0);
      const best = new Map<string, ConnectorCatalogItem>();
      for (const item of await loadIndex()) {
        if (!item.mcpUrl) continue;
        const key = appNameKey(item.name);
        const current = best.get(key);
        if (
          !current ||
          rank(item) > rank(current) ||
          (rank(item) === rank(current) && (item.popularity ?? 0) > (current.popularity ?? 0))
        )
          best.set(key, item);
      }
      return new Map([...best].map(([key, item]) => [key, item.mcpUrl!]));
    },

    async detail(id: string): Promise<ConnectorCatalogDetail> {
      const items = await loadIndex();
      const item = items.find((candidate) => candidate.id === id);
      if (!item) throw new Error('Connector not found');
      const variants = await loadSurfaces(item.domain);
      return {
        item,
        variants: [
          ...variants,
          ...(options.source ? [] : (OFFICIAL_SURFACE_ENRICHMENTS[item.domain] ?? [])),
        ],
      };
    },
  };
}

const catalog = createConnectorCatalog();

export const listConnectorCatalog = catalog.list;
export const connectorCatalogSections = catalog.sections;
export const getConnectorCatalogDetail = catalog.detail;
export const connectorCatalogIcons = catalog.icons;
export const connectorCatalogDirectIds = catalog.directIds;
export const connectorCatalogDirectMcpUrls = catalog.directMcpUrls;
export const connectorCatalogItems = catalog.items;
export const connectorCatalogSurfaces = catalog.surfaces;
