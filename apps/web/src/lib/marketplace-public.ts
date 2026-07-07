// Server-safe marketplace reads. This module talks to the public, unauthenticated
// `/v1/marketplace/*` directory endpoints with plain `fetch` and MUST NOT import
// `@/lib/api-client` (a `'use client'` module that initializes browser-only
// stores at eval time). Keeping these reads here lets Server Components — the
// public detail page's `generateMetadata` and render — fetch without dragging
// the client bundle across the server boundary. Types are imported `type`-only
// so the client module is never loaded at runtime.

import { getEnv } from '@/lib/env-config';
import type {
  ItemsPage,
  MarketplaceItem,
  MarketplaceItemDetail,
  MarketplaceItemFile,
  MarketplacesPage,
  MarketplaceSummary,
  PendingSource,
} from '@/lib/marketplace-client';

/** Static/ISR revalidation for public marketplace catalog reads. */
export const MARKETPLACE_PUBLIC_REVALIDATE_SECONDS = 3600;

function publicApiOrigin(): string {
  const backend = getEnv().BACKEND_URL || '';
  return backend.replace(/\/$/, '').replace(/\/v1$/, '');
}

async function publicGet<T>(path: string): Promise<T> {
  const base = publicApiOrigin();
  const response = await fetch(`${base}/v1${path.startsWith('/') ? path : `/${path}`}`, {
    headers: { Accept: 'application/json' },
    next: { revalidate: MARKETPLACE_PUBLIC_REVALIDATE_SECONDS },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T>;
}

/** Client-side filter mirroring the public catalog query params. */
export function filterPublicMarketplaceItems(
  items: MarketplaceItem[],
  params?: { query?: string; type?: string; source?: string },
): MarketplaceItem[] {
  const q = (params?.query ?? '').trim().toLowerCase();
  const type = params?.type?.trim();
  const source = params?.source?.trim();
  return items.filter((it) => {
    if (type && type !== 'all' && it.type !== type && it.type !== `registry:${type}`) return false;
    if (source && source !== 'all' && it.marketplaceId !== source) return false;
    if (!q) return true;
    return `${it.name} ${it.title} ${it.description ?? ''} ${it.categories.join(' ')}`
      .toLowerCase()
      .includes(q);
  });
}

export async function listPublicMarketplaceItems(params?: {
  query?: string;
  type?: string;
  source?: string;
  /** Opt-in server-side pagination. Omit for the full filtered list. */
  limit?: number;
  offset?: number;
}): Promise<ItemsPage> {
  const qs = new URLSearchParams();
  if (params?.query) qs.set('query', params.query);
  if (params?.type && params.type !== 'all') qs.set('type', params.type);
  if (params?.source && params.source !== 'all') qs.set('source', params.source);
  if (params?.limit !== undefined) qs.set('limit', String(params.limit));
  if (params?.offset !== undefined) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await publicGet<{
    items: MarketplaceItem[];
    total?: number;
    hasMore?: boolean;
    loading?: boolean;
    pending?: number;
    sources?: PendingSource[];
  }>(`/marketplace/items${suffix}`);
  const items = res.items ?? [];
  return {
    items,
    // Servers/callers predating pagination won't send these — fall back to a
    // valid single-page shape so `ItemsPage` is never partially populated.
    total: res.total ?? items.length,
    hasMore: res.hasMore ?? false,
    loading: !!res.loading,
    pending: res.pending ?? 0,
    sources: res.sources ?? [],
  };
}

export async function listPublicMarketplaces(): Promise<MarketplacesPage> {
  const res = await publicGet<{
    marketplaces: MarketplaceSummary[];
    loading?: boolean;
    pending?: number;
    sources?: PendingSource[];
  }>(`/marketplace/marketplaces`);
  return {
    marketplaces: res.marketplaces ?? [],
    loading: !!res.loading,
    pending: res.pending ?? 0,
    sources: res.sources ?? [],
  };
}

/** Unauthenticated detail read for the public marketplace directory. */
export async function getPublicMarketplaceItem(id: string): Promise<MarketplaceItemDetail> {
  return publicGet<MarketplaceItemDetail>(`/marketplace/items/${encodeURIComponent(id)}`);
}

/** Unauthenticated single-file read for the public marketplace detail viewer. */
export async function getPublicMarketplaceItemFile(
  id: string,
  target: string,
): Promise<MarketplaceItemFile> {
  return publicGet<MarketplaceItemFile>(
    `/marketplace/items/${encodeURIComponent(id)}/file?path=${encodeURIComponent(target)}`,
  );
}

// ── Bounded SSR loaders (A4) ────────────────────────────────────────────────
// The public marketplace pages used to fetch the *entire* catalog on every
// ISR render and hand it to the client, which hung/rendered-forever on a
// large catalog. These loaders bound the SSR fetch; the client then hydrates
// into the infinite-scroll + virtualized views (`MarketplacePagedGrid`) for
// anything beyond the first page.

/** Canonical marketplace items page size. Lives in this server-safe module
 *  (which the client hook can import without pulling in client-only code, but
 *  not vice-versa) so the SSR first-page limits below and the client's
 *  `useInfiniteMarketplaceItems` page size derive from a single source — the
 *  company page's `initialData` seed/offset math only lines up if they stay
 *  equal. */
export const MARKETPLACE_ITEMS_PAGE_SIZE = 30;

/** First-page size for the `/marketplace/[company]` SSR fetch — must equal the
 *  client hook's page size so the seeded first page and its `offset` align. */
export const MARKETPLACE_COMPANY_PAGE_LIMIT = MARKETPLACE_ITEMS_PAGE_SIZE;

/** First-page size for the `/marketplace` landing SSR fetch — large enough to
 *  fill each type section's ~9-item preview (and the featured rail) in the
 *  common case, without being an unbounded full-catalog fetch. A single
 *  unsorted fetch can't *guarantee* 9-per-type on a very skewed catalog; the
 *  landing's "See all" already routes through the paged view for that case. */
export const MARKETPLACE_EXPLORE_LANDING_LIMIT = 120;

function emptyItemsPage(): ItemsPage {
  return { items: [], total: 0, hasMore: false, loading: false, pending: 0, sources: [] };
}

function emptyMarketplacesPage(): MarketplacesPage {
  return { marketplaces: [], loading: false, pending: 0, sources: [] };
}

/** Bounded data for the `/marketplace` landing page's SSR render. */
export async function loadMarketplaceExploreData(): Promise<{
  itemsPage: ItemsPage;
  marketplacesPage: MarketplacesPage;
}> {
  try {
    const [itemsPage, marketplacesPage] = await Promise.all([
      listPublicMarketplaceItems({ limit: MARKETPLACE_EXPLORE_LANDING_LIMIT }),
      listPublicMarketplaces(),
    ]);
    return { itemsPage, marketplacesPage };
  } catch {
    return { itemsPage: emptyItemsPage(), marketplacesPage: emptyMarketplacesPage() };
  }
}

/** Bounded, source-scoped data for the `/marketplace/[company]` page's SSR
 *  render — the server filters by `source` directly instead of fetching the
 *  full catalog and filtering client-side. */
export async function loadMarketplaceCompanyData(marketplaceId: string): Promise<{
  itemsPage: ItemsPage;
  marketplacesPage: MarketplacesPage;
}> {
  try {
    const [itemsPage, marketplacesPage] = await Promise.all([
      listPublicMarketplaceItems({ source: marketplaceId, limit: MARKETPLACE_COMPANY_PAGE_LIMIT }),
      listPublicMarketplaces(),
    ]);
    return { itemsPage, marketplacesPage };
  } catch {
    return { itemsPage: emptyItemsPage(), marketplacesPage: emptyMarketplacesPage() };
  }
}
