import { backendApi } from '@/lib/api-client';

// Server-safe public reads live in a separate module (no api-client import) so
// Server Components can call them. Re-exported here for existing client imports.
export {
  getPublicMarketplaceItem,
  getPublicMarketplaceItemFile,
  listPublicMarketplaceItems,
  listPublicMarketplaces,
} from '@/lib/marketplace-public';

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

function unwrap<T>(response: { data?: T; success: boolean; error?: Error }): T {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error('Request failed');
  }
  return response.data;
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
  /** Total items matching the filter (server-computed; `items.length` when the
   *  call isn't paged). */
  total: number;
  /** True when more items exist beyond this page (always `false` for an
   *  unpaged call, which already returns everything). */
  hasMore: boolean;
  loading: boolean;
  pending: number;
  sources: PendingSource[];
}

export async function listMarketplaceItems(params?: {
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
  const res = unwrap(
    await backendApi.get<{
      items: MarketplaceItem[];
      total?: number;
      hasMore?: boolean;
      loading?: boolean;
      pending?: number;
      sources?: PendingSource[];
    }>(`/marketplace/items${suffix}`),
  );
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

export function defaultProjectMarketplaceItems(
  items: MarketplaceItem[] | undefined,
): MarketplaceItem[] {
  return (items ?? [])
    .filter((item) => item.defaultProjectInstall)
    .sort(
      (a, b) =>
        (a.defaultProjectInstallOrder ?? 999) - (b.defaultProjectInstallOrder ?? 999) ||
        a.name.localeCompare(b.name),
    );
}

export async function listDefaultProjectMarketplaceItems(): Promise<MarketplaceItem[]> {
  const page = await listMarketplaceItems({ source: 'kortix', type: 'skill' });
  return defaultProjectMarketplaceItems(page.items);
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

export interface FeaturedMarketplace {
  address: string;
  label: string;
  owner: string;
  description: string;
  license: string;
  added: boolean;
}

export async function listFeaturedMarketplaces(): Promise<FeaturedMarketplace[]> {
  const res = unwrap(
    await backendApi.get<{ featured: FeaturedMarketplace[] }>(`/marketplace/marketplaces/featured`),
  );
  return res.featured ?? [];
}

export async function getMarketplaceItem(id: string): Promise<MarketplaceItemDetail> {
  return unwrap(
    await backendApi.get<MarketplaceItemDetail>(`/marketplace/items/${encodeURIComponent(id)}`),
  );
}

export interface MarketplaceItemFile {
  target: string;
  content: string;
}

/** One file's raw content (addressed by its install target) for the detail viewer. */
export async function getMarketplaceItemFile(
  id: string,
  target: string,
): Promise<MarketplaceItemFile> {
  return unwrap(
    await backendApi.get<MarketplaceItemFile>(
      `/marketplace/items/${encodeURIComponent(id)}/file?path=${encodeURIComponent(target)}`,
    ),
  );
}

/** Install ANY marketplace item (skill/agent/command/tool, or a whole
 *  `registry:project`) into a project via an agent session instead of a
 *  deterministic file commit — the session installs it and wires up whatever
 *  it needs (connectors, secrets), or for a `registry:project` merges it into
 *  an existing project's kortix.yaml, which isn't safe to do deterministically.
 *  Starts a session with a constructed prompt; the caller should navigate into
 *  `session_id` to watch it work. */
export async function installMarketplaceItemAsSession(
  projectId: string,
  id: string,
): Promise<{ session_id: string }> {
  return unwrap(
    await backendApi.post<{ session_id: string }>(
      `/projects/${projectId}/marketplace/install-session`,
      { id },
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
  const res = unwrap(
    await backendApi.get<{ sources: MarketplaceSource[] }>(`/marketplace/sources`),
  );
  return res.sources ?? [];
}

export async function addMarketplaceSource(input: AddSourceInput): Promise<MarketplaceSource> {
  const res = unwrap(
    await backendApi.post<{ source: MarketplaceSource }>(`/marketplace/sources`, input),
  );
  return res.source;
}

export async function removeMarketplaceSource(id: string): Promise<void> {
  unwrap(
    await backendApi.delete<{ ok: boolean }>(`/marketplace/sources/${encodeURIComponent(id)}`),
  );
}
