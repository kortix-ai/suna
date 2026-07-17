const INTEGRATIONS_BASE_URL = 'https://integrations.sh';
const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_SIZE = 48;
const MAX_PAGE_SIZE = 96;

const OFFICIAL_SURFACE_ENRICHMENTS: Record<string, IntegrationSurfaceVariant[]> = {
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

export type IntegrationCatalogKind = 'openapi' | 'mcp' | 'graphql' | 'cli';

export interface IntegrationCatalogItem {
  id: string;
  kind: IntegrationCatalogKind;
  slug: string;
  name: string;
  description: string | null;
  url: string | null;
  icon: string | null;
  domain: string;
  categories: string[];
  feeds: string[];
  popularity: number | null;
}

export interface IntegrationConnectorTemplate {
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

export interface IntegrationSurfaceVariant {
  id: string;
  kind: 'openapi' | 'postman' | 'mcp' | 'graphql' | 'http' | 'cli';
  name: string;
  url: string | null;
  docs: string | null;
  description: string | null;
  transports: string[];
  requiresAuth: boolean;
  command: string | null;
  connector: IntegrationConnectorTemplate | null;
}

export interface IntegrationCatalogDetail {
  item: IntegrationCatalogItem;
  variants: IntegrationSurfaceVariant[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CatalogOptions {
  fetch?: FetchLike;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeItem(value: unknown): IntegrationCatalogItem | null {
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
  };
}

function authTemplate(
  surface: Record<string, unknown>,
): IntegrationConnectorTemplate['auth'] | undefined {
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
        | Record<string, unknown>
        | undefined;
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

function normalizeSurface(value: unknown, index: number): IntegrationSurfaceVariant | null {
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
  const withAuth = <T extends IntegrationConnectorTemplate>(connector: T): T =>
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

export function createIntegrationCatalog(options: CatalogOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let indexCache: { items: IntegrationCatalogItem[]; at: number } | null = null;
  let indexRequest: Promise<IntegrationCatalogItem[]> | null = null;
  const surfaceCache = new Map<string, { value: IntegrationSurfaceVariant[]; at: number }>();
  const surfaceRequests = new Map<string, Promise<IntegrationSurfaceVariant[]>>();

  const fetchJson = async (url: string): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`integrations.sh returned ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  };

  const loadIndex = async (): Promise<IntegrationCatalogItem[]> => {
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
          .filter((item): item is IntegrationCatalogItem => item !== null);
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

  const loadSurfaces = async (domain: string): Promise<IntegrationSurfaceVariant[]> => {
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
          .filter((variant): variant is IntegrationSurfaceVariant => variant !== null);
        surfaceCache.set(domain, { value: variants, at: now() });
        return variants;
      } catch (error) {
        if (cached) return cached.value;
        throw error;
      } finally {
        surfaceRequests.delete(domain);
      }
    })();
    surfaceRequests.set(domain, request);
    return request;
  };

  return {
    async list(input: { q?: string; cursor?: string; limit?: number } = {}) {
      const items = await loadIndex();
      const query = input.q?.trim().toLowerCase() ?? '';
      const filtered = query
        ? items.filter((item) =>
            [item.name, item.description, item.domain, item.kind, ...item.categories]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(query)),
          )
        : items;
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

    async detail(id: string): Promise<IntegrationCatalogDetail> {
      const items = await loadIndex();
      const item = items.find((candidate) => candidate.id === id);
      if (!item) throw new Error('Integration not found');
      const variants = await loadSurfaces(item.domain);
      return {
        item,
        variants: [...variants, ...(OFFICIAL_SURFACE_ENRICHMENTS[item.domain] ?? [])],
      };
    },
  };
}

const catalog = createIntegrationCatalog();

export const listIntegrationCatalog = catalog.list;
export const getIntegrationCatalogDetail = catalog.detail;
