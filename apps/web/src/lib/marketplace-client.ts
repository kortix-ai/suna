import { backendApi } from '@/lib/api-client';
import { getEnv } from '@/lib/env-config';

export interface ItemCapabilities {
  secrets: string[];
  connectors: string[];
  tools: string[];
  network: string[];
}

export interface MarketplaceItem {
  id: string;
  registry: string;
  name: string;
  type: string;
  title: string;
  description: string | null;
  categories: string[];
  capabilities: ItemCapabilities;
  dependencies: string[];
  fileCount: number;
  /** True when the item comes from an external registry. */
  external: boolean;
  /** Provenance link (e.g. the GitHub repo), when known. */
  sourceUrl?: string;
  /** Canonical marketplace identity (server-computed — never re-derived client-side). */
  marketplaceId: string;
  marketplaceLabel: string;
  owner?: string;
  sourceId?: string;
  defaultProjectInstall?: boolean;
  defaultProjectInstallOrder?: number;
}

export interface DependencyItem {
  id: string;
  name: string;
  type: string;
  title: string;
  description: string | null;
}

export interface MarketplaceItemDetail extends MarketplaceItem {
  files: Array<{ target: string; type: string }>;
  readme: string | null;
  dependencyItems: DependencyItem[];
}

export interface InstallResult {
  ok: boolean;
  commit_sha: string;
  branch: string;
  file_count: number;
  installed: Array<{ name: string; type: string }>;
  capabilities: ItemCapabilities;
}

export interface InstalledItem {
  name: string;
  type: string;
  source: string;
  installed_at: string | null;
  file_count: number;
}

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }): T {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Request failed');
  }
  return response.data;
}

async function publicGet<T>(path: string): Promise<T> {
  const base = typeof window === 'undefined' ? getEnv().BACKEND_URL.replace(/\/$/, '').replace(/\/v1$/, '') : '';
  const response = await fetch(`${base}/v1${path.startsWith('/') ? path : `/${path}`}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T>;
}

/** A source still resolving during the cold first-load — rendered as a spinner
 *  pill until it lands and becomes a real facet. */
export interface PendingSource {
  id: string;
  label: string;
  owner?: string;
  sourceUrl?: string;
  status: 'pending' | 'ready' | 'error';
}

/** A list page that also reports whether the catalog is still streaming sources
 *  in (cold first-load) so the UI can show per-source spinners + poll. */
export interface ItemsPage {
  items: MarketplaceItem[];
  loading: boolean;
  pending: number;
  sources: PendingSource[];
}

export async function listMarketplaceItems(params?: {
  query?: string;
  type?: string;
  source?: string;
}): Promise<ItemsPage> {
  const qs = new URLSearchParams();
  if (params?.query) qs.set('query', params.query);
  if (params?.type && params.type !== 'all') qs.set('type', params.type);
  if (params?.source && params.source !== 'all') qs.set('source', params.source);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = unwrap(
    await backendApi.get<{
      items: MarketplaceItem[];
      loading?: boolean;
      pending?: number;
      sources?: PendingSource[];
    }>(`/marketplace/items${suffix}`),
  );
  return { items: res.items ?? [], loading: !!res.loading, pending: res.pending ?? 0, sources: res.sources ?? [] };
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
  return { items: res.items ?? [], loading: !!res.loading, pending: res.pending ?? 0, sources: res.sources ?? [] };
}

export interface MarketplaceSummary {
  id: string;
  label: string;
  owner?: string;
  count: number;
  types: Record<string, number>;
  external: boolean;
  sourceUrl?: string;
  /** The user-added source row (for exact Remove); absent for base/env marketplaces. */
  sourceId?: string;
}

export interface MarketplacesPage {
  marketplaces: MarketplaceSummary[];
  loading: boolean;
  pending: number;
  sources: PendingSource[];
}

export async function listMarketplaces(): Promise<MarketplacesPage> {
  const res = unwrap(
    await backendApi.get<{
      marketplaces: MarketplaceSummary[];
      loading?: boolean;
      pending?: number;
      sources?: PendingSource[];
    }>(`/marketplace/marketplaces`),
  );
  return {
    marketplaces: res.marketplaces ?? [],
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

export interface FeaturedMarketplace {
  address: string;
  label: string;
  owner: string;
  description: string;
  license: string;
  added: boolean;
}

export async function listFeaturedMarketplaces(): Promise<FeaturedMarketplace[]> {
  const res = unwrap(await backendApi.get<{ featured: FeaturedMarketplace[] }>(`/marketplace/marketplaces/featured`));
  return res.featured ?? [];
}

export async function getMarketplaceItem(id: string): Promise<MarketplaceItemDetail> {
  return unwrap(await backendApi.get<MarketplaceItemDetail>(`/marketplace/items/${encodeURIComponent(id)}`));
}

export interface MarketplaceItemFile {
  target: string;
  content: string;
}

/** One file's raw content (addressed by its install target) for the detail viewer. */
export async function getMarketplaceItemFile(id: string, target: string): Promise<MarketplaceItemFile> {
  return unwrap(
    await backendApi.get<MarketplaceItemFile>(
      `/marketplace/items/${encodeURIComponent(id)}/file?path=${encodeURIComponent(target)}`,
    ),
  );
}

export async function installMarketplaceItem(projectId: string, id: string): Promise<InstallResult> {
  return unwrap(await backendApi.post<InstallResult>(`/projects/${projectId}/registry/install`, { id }));
}

export async function listInstalledItems(projectId: string): Promise<InstalledItem[]> {
  const res = unwrap(await backendApi.get<{ installed: InstalledItem[] }>(`/projects/${projectId}/registry`));
  return res.installed ?? [];
}

export type RegistryItemStatus = 'up-to-date' | 'update-available' | 'orphaned';

export interface RegistryUpdate {
  name: string;
  type: string;
  status: RegistryItemStatus;
  /** Count of changed/added/removed files at the source. */
  changed: number;
}

export async function listRegistryUpdates(
  projectId: string,
): Promise<{ updates: RegistryUpdate[]; update_available: string[] }> {
  return unwrap(
    await backendApi.get<{ updates: RegistryUpdate[]; update_available: string[] }>(
      `/projects/${projectId}/registry/updates`,
    ),
  );
}

export async function updateMarketplaceItem(
  projectId: string,
  name: string,
): Promise<{ ok: boolean; updated: string; commit_sha: string; file_count: number }> {
  return unwrap(
    await backendApi.post<{ ok: boolean; updated: string; commit_sha: string; file_count: number }>(
      `/projects/${projectId}/registry/update`,
      { name },
    ),
  );
}

export async function uninstallMarketplaceItem(
  projectId: string,
  name: string,
): Promise<{ ok: boolean; removed: string; commit_sha: string; file_count: number }> {
  return unwrap(
    await backendApi.delete<{ ok: boolean; removed: string; commit_sha: string; file_count: number }>(
      `/projects/${projectId}/registry/${encodeURIComponent(name)}`,
    ),
  );
}

// ── "Add a marketplace" sources ─────────────────────────────────────────────

export interface MarketplaceSource {
  id: string;
  address: string;
  gitRef?: string;
  sparsePaths?: string[];
  label?: string;
  addedAt: string;
}

export interface AddSourceInput {
  address: string;
  gitRef?: string;
  sparsePaths?: string[];
  label?: string;
}

export async function listMarketplaceSources(): Promise<MarketplaceSource[]> {
  const res = unwrap(await backendApi.get<{ sources: MarketplaceSource[] }>(`/marketplace/sources`));
  return res.sources ?? [];
}

export async function addMarketplaceSource(input: AddSourceInput): Promise<MarketplaceSource> {
  const res = unwrap(await backendApi.post<{ source: MarketplaceSource }>(`/marketplace/sources`, input));
  return res.source;
}

export async function removeMarketplaceSource(id: string): Promise<void> {
  unwrap(await backendApi.delete<{ ok: boolean }>(`/marketplace/sources/${encodeURIComponent(id)}`));
}
