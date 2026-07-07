// Public marketplace catalog browse (`/v1/marketplace/*`) — distinct from the
// project-scoped install surface in `./marketplace.ts` (`/projects/:id/marketplace/*`,
// `/projects/:id/registry/*`). Read-only catalog routes are public; the
// "sources" ("Add a marketplace") routes require auth. See
// apps/api/src/marketplace/index.ts for the server-side handlers.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

export interface MarketplaceCatalogItem {
  id: string;
  title: string;
  type: string;
  source: string;
  description?: string | null;
  [key: string]: unknown;
}

export interface MarketplaceCatalogStatus {
  loading?: boolean;
  pending?: string[];
  sources?: string[];
}

export interface MarketplaceItemsResponse extends MarketplaceCatalogStatus {
  items: MarketplaceCatalogItem[];
}

export interface ListMarketplaceItemsOptions {
  query?: string;
  type?: string;
  source?: string;
}

/** Browse the public registry catalog (no auth required). */
export async function listMarketplaceCatalogItems(
  options?: ListMarketplaceItemsOptions,
): Promise<MarketplaceItemsResponse> {
  const params = new URLSearchParams();
  if (options?.query) params.set('query', options.query);
  if (options?.type) params.set('type', options.type);
  if (options?.source) params.set('source', options.source);
  const query = params.toString() ? `?${params.toString()}` : '';
  return unwrap(await backendApi.get<MarketplaceItemsResponse>(`/marketplace/items${query}`));
}

export interface MarketplaceEntry {
  name: string;
  item_count: number;
  [key: string]: unknown;
}

export interface MarketplacesResponse extends MarketplaceCatalogStatus {
  marketplaces: MarketplaceEntry[];
}

/** Distinct marketplaces (sources) with item counts. */
export async function listMarketplaces(): Promise<MarketplacesResponse> {
  return unwrap(await backendApi.get<MarketplacesResponse>('/marketplace/marketplaces'));
}

export interface FeaturedMarketplacesResponse {
  featured: MarketplaceEntry[];
}

/** Curated featured marketplaces. */
export async function listFeaturedMarketplaces(): Promise<FeaturedMarketplacesResponse> {
  return unwrap(await backendApi.get<FeaturedMarketplacesResponse>('/marketplace/marketplaces/featured'));
}

/** A single catalog item's full detail (manifest + file listing). */
export async function getMarketplaceCatalogItem(id: string): Promise<Record<string, unknown>> {
  return unwrap(
    await backendApi.get<Record<string, unknown>>(`/marketplace/items/${encodeURIComponent(id)}`),
    'Item not found',
  );
}

export interface MarketplaceItemFile {
  path: string;
  content: string;
  [key: string]: unknown;
}

/** Read a single file's content out of a catalog item (before installing it). */
export async function getMarketplaceCatalogItemFile(
  id: string,
  path: string,
): Promise<MarketplaceItemFile> {
  return unwrap(
    await backendApi.get<MarketplaceItemFile>(
      `/marketplace/items/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
    ),
    'File not found',
  );
}

// ── Sources ("Add a marketplace") — authed, platform-global ────────────────

export interface MarketplaceSource {
  id: string;
  address: string;
  gitRef?: string | null;
  sparsePaths?: string[] | null;
  label?: string | null;
  [key: string]: unknown;
}

export interface MarketplaceSourcesResponse {
  sources: MarketplaceSource[];
}

/** List operator-managed marketplace sources (a GitHub repo, Git URL, or local folder). */
export async function listMarketplaceSources(): Promise<MarketplaceSourcesResponse> {
  return unwrap(await backendApi.get<MarketplaceSourcesResponse>('/marketplace/sources'));
}

export interface AddMarketplaceSourceInput {
  address: string;
  gitRef?: string;
  sparsePaths?: string[];
  label?: string;
}

export interface AddMarketplaceSourceResponse {
  source: MarketplaceSource;
}

/** Add a marketplace source. Rejects local-folder/private/non-https addresses server-side. */
export async function addMarketplaceSource(
  input: AddMarketplaceSourceInput,
): Promise<AddMarketplaceSourceResponse> {
  return unwrap(
    await backendApi.post<AddMarketplaceSourceResponse>('/marketplace/sources', input),
    'Failed to add marketplace source',
  );
}

/** Remove a marketplace source by id. */
export async function removeMarketplaceSource(id: string): Promise<{ ok: boolean }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/marketplace/sources/${encodeURIComponent(id)}`),
    'Failed to remove marketplace source',
  );
}
