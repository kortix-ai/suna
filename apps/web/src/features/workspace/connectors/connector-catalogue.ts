/**
 * The connectors catalogue, as data.
 *
 * Pure: no React, no fetching. The screen builds its entries from two live
 * sources — `listConnectors` (what this project has already added) and
 * `listPipedreamApps` (what it could add) — and this module merges, filters,
 * groups and pages them.
 *
 * Everything on screen is the provider's own data. Names, descriptions, icons,
 * categories and status all come from the API; the group headings are the
 * categories it returns, not a taxonomy of ours. An earlier version filed
 * entries against a hand-written slug allowlist, which showed a curated slice
 * of a directory with thousands of apps under headings we invented.
 */

/** Structurally compatible with `AdminConnector` from `@kortix/sdk`. */
export interface CatalogueConnectedInput {
  slug: string;
  name: string;
  provider: string;
  iconUrl?: string | null;
  status: string;
  actions: unknown[];
  authSecret: string | null;
  secretSet: boolean;
}

/** Structurally compatible with `PipedreamApp` from `@kortix/sdk`. */
export interface CatalogueAvailableInput {
  slug: string;
  name: string;
  description: string | null;
  imgSrc: string | null;
  categories: string[];
}

export interface CatalogueEntry {
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  /** Free-text, straight from the API. Only ever used for the category filter. */
  categories: string[];
  /** This project has already added it. */
  connected: boolean;
  /** Added, but its credential is still missing — "Needs setup" in the rail. */
  needsSetup: boolean;
  /** Added, and its last sync failed. */
  failing: boolean;
  /**
   * A one-click app whose OAuth Kortix operates, rather than a connector
   * somebody pointed at a URL by hand. This is the only "trusted" signal the
   * API actually gives us, so it is the only one the card marks.
   */
  official: boolean;
  /** Tools the connector exposes, once added. `null` while it is only available. */
  toolCount: number | null;
}

export type CataloguePill = 'discover' | 'all' | 'connected' | 'available';

export const CATALOGUE_PILLS: { id: CataloguePill; label: string }[] = [
  { id: 'discover', label: 'Discover' },
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'available', label: 'Available' },
];

export interface CatalogueGroup {
  id: string;
  label: string;
  entries: CatalogueEntry[];
  /**
   * Kept so the grid can note a heading that is not the provider's own. Always
   * false now that groups come from API categories; the only non-category
   * group is "Connected", which is the project's own data.
   */
  curated: boolean;
}

function connectedEntry(connector: CatalogueConnectedInput): CatalogueEntry {
  const needsSetup = Boolean(connector.authSecret) && !connector.secretSet;
  return {
    slug: connector.slug,
    name: connector.name || connector.slug,
    description: null,
    iconUrl: connector.iconUrl ?? null,
    categories: [],
    // ADDED to the project is not the same as CONNECTED. A connector whose
    // credential is missing can call nothing, so it must not sit in the
    // "Connected" group, match the Connected pill, or wear the green tick —
    // all three read as "this works" on a screen about granting access.
    connected: !needsSetup,
    needsSetup,
    failing: connector.status === 'error',
    official: connector.provider === 'pipedream',
    toolCount: connector.actions.length,
  };
}

function availableEntry(app: CatalogueAvailableInput): CatalogueEntry {
  return {
    slug: app.slug,
    name: app.name || app.slug,
    description: app.description ?? null,
    iconUrl: app.imgSrc ?? null,
    categories: app.categories ?? [],
    connected: false,
    needsSetup: false,
    failing: false,
    official: true,
    toolCount: null,
  };
}

/**
 * One list, connected first. A connector the project already has wins over the
 * catalogue row for the same slug — otherwise Gmail would appear twice, once
 * with its real status and once as if it were still available.
 *
 * The available side keeps whatever description the API sent; where the two
 * overlap we borrow it, because `listConnectors` does not return one.
 */
export function buildCatalogueEntries(input: {
  connectors: CatalogueConnectedInput[];
  apps: CatalogueAvailableInput[];
}): CatalogueEntry[] {
  const appBySlug = new Map(input.apps.map((app) => [app.slug, app]));
  const connected = input.connectors.map((connector) => {
    const entry = connectedEntry(connector);
    const app = appBySlug.get(connector.slug);
    if (!app) return entry;
    return {
      ...entry,
      description: app.description ?? null,
      iconUrl: entry.iconUrl ?? app.imgSrc ?? null,
      categories: app.categories ?? [],
    };
  });
  const takenSlugs = new Set(connected.map((entry) => entry.slug));
  const available = input.apps
    .filter((app) => !takenSlugs.has(app.slug))
    .map((app) => availableEntry(app));
  return [...connected, ...available];
}

export function catalogueMatchesQuery(entry: CatalogueEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.name.toLowerCase().includes(q) ||
    entry.slug.toLowerCase().includes(q) ||
    (entry.description ?? '').toLowerCase().includes(q)
  );
}

export function filterCatalogue(
  entries: CatalogueEntry[],
  options: { query?: string; pill?: CataloguePill; category?: string },
): CatalogueEntry[] {
  const { query = '', pill = 'discover', category = '' } = options;
  return entries.filter((entry) => {
    if (pill === 'connected' && !entry.connected) return false;
    if (pill === 'available' && entry.connected) return false;
    if (category && !entry.categories.includes(category)) return false;
    return catalogueMatchesQuery(entry, query);
  });
}

/**
 * Categories seen in the entries loaded SO FAR. Both catalogue endpoints are
 * cursor-paged, so this list grows as more pages arrive — the picker labels
 * itself accordingly rather than pretending to be the full taxonomy.
 */
export function catalogueCategories(entries: CatalogueEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const category of entry.categories) {
      const trimmed = category.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * The Discover view: the project's own connectors first, then the category
 * groups, then everything the curation does not mention. A group with no
 * matching entry is dropped rather than rendered empty.
 */
/** How many category groups to show before the rest fall into "More". */
export const MAX_CATEGORY_GROUPS = 8;

/**
 * Group the catalogue by the categories the API actually returns.
 *
 * This used to file entries against a hardcoded slug allowlist, which meant the
 * screen showed a curated slice of a directory that has thousands of apps, and
 * the headings were our invention rather than anything real. `PipedreamApp`
 * carries `categories`, so the grouping is just that data, and the headings are
 * the provider's own.
 *
 * Categories are ordered by how many connectors they hold, so the biggest
 * shelves lead. An app in several categories is filed under its largest one, so
 * no card appears twice.
 */
export function groupCatalogue(entries: CatalogueEntry[]): CatalogueGroup[] {
  const groups: CatalogueGroup[] = [];

  const connected = entries.filter((entry) => entry.connected);
  if (connected.length > 0) {
    groups.push({ id: 'connected', label: 'Connected', entries: connected, curated: false });
  }

  const available = entries.filter((entry) => !entry.connected);

  // Count first, so an app in several categories can be filed under the
  // largest one rather than duplicated across all of them.
  const counts = new Map<string, number>();
  for (const entry of available) {
    for (const category of entry.categories) {
      const name = category.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  const rank = new Map(ranked.map((name, index) => [name, index]));

  const byCategory = new Map<string, CatalogueEntry[]>();
  const uncategorised: CatalogueEntry[] = [];
  for (const entry of available) {
    const named = entry.categories.map((c) => c.trim()).filter(Boolean);
    if (named.length === 0) {
      uncategorised.push(entry);
      continue;
    }
    const best = named.reduce((a, b) =>
      (rank.get(a) ?? Number.MAX_SAFE_INTEGER) <= (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ? a : b,
    );
    const bucket = byCategory.get(best);
    if (bucket) bucket.push(entry);
    else byCategory.set(best, [entry]);
  }

  const shown = ranked.slice(0, MAX_CATEGORY_GROUPS);
  const overflow: CatalogueEntry[] = [...uncategorised];
  for (const name of ranked.slice(MAX_CATEGORY_GROUPS)) {
    overflow.push(...(byCategory.get(name) ?? []));
  }

  for (const name of shown) {
    const bucket = byCategory.get(name);
    if (!bucket || bucket.length === 0) continue;
    groups.push({ id: `category:${name}`, label: name, entries: bucket, curated: false });
  }

  if (overflow.length > 0) {
    groups.push({ id: 'more', label: 'More connectors', entries: overflow, curated: false });
  }

  return groups;
}

/** Cards per page inside one group — 3 columns × 2 rows, as in the reference. */
export const GROUP_PAGE_SIZE = 6;

export function pageCount(total: number, pageSize: number = GROUP_PAGE_SIZE): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamps rather than throws, so a stale page index cannot blank a group. */
export function pageSlice<T>(items: T[], page: number, pageSize: number = GROUP_PAGE_SIZE): T[] {
  if (pageSize <= 0) return items;
  const last = pageCount(items.length, pageSize) - 1;
  const safe = Math.min(Math.max(page, 0), last);
  return items.slice(safe * pageSize, safe * pageSize + pageSize);
}
