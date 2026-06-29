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

async function publicGet<T>(path: string): Promise<T> {
  const base =
    typeof window === 'undefined'
      ? getEnv().BACKEND_URL.replace(/\/$/, '').replace(/\/v1$/, '')
      : '';
  const response = await fetch(`${base}/v1${path.startsWith('/') ? path : `/${path}`}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T>;
}

export async function listPublicMarketplaceItems(params?: {
  query?: string;
  type?: string;
  source?: string;
}): Promise<ItemsPage> {
  const qs = new URLSearchParams();
  if (params?.query) qs.set('query', params.query);
  if (params?.type && params.type !== 'all') qs.set('type', params.type);
  if (params?.source && params.source !== 'all') qs.set('source', params.source);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await publicGet<{
    items: MarketplaceItem[];
    loading?: boolean;
    pending?: number;
    sources?: PendingSource[];
  }>(`/marketplace/items${suffix}`);
  return {
    items: res.items ?? [],
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
