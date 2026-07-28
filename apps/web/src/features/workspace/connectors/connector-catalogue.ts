/**
 * The connectors catalogue, as data.
 *
 * Pure: no React, no fetching. The screen builds its entries from two live
 * sources — `listConnectors` (what this project has already added) and
 * `listPipedreamApps` (what it could add) — and this module merges, filters,
 * groups and pages them.
 *
 * WHY THE GROUPS ARE HAND-AUTHORED. The API has no group taxonomy. Both
 * `PipedreamApp.categories` and `DiscoverIntegration.categories` are free-text
 * string arrays from two different vocabularies, and both endpoints are
 * cursor-paged — so a grouping derived from them would only ever know the
 * categories of the pages already fetched, would grow as you scroll, and would
 * be wrong on first paint. `CURATED_GROUPS` is therefore a FRONTEND CURATION:
 * an ordered allowlist of slugs per group, maintained here, not served.
 *
 * What curation does NOT do: it never supplies a name, description, icon or
 * status. Those always come from the API. A curated slug the API did not
 * return simply never renders — so the list can be stale or wrong without ever
 * showing a connector that does not exist. Adding a slug here does not add an
 * integration; it only decides where a real one is filed.
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

export interface CuratedGroup {
  id: string;
  label: string;
  /** Ordered allowlist. Slugs the API never returns are silently dropped. */
  slugs: string[];
}

/**
 * Hand-authored filing, not API data. See the module comment before editing.
 * Slugs are Pipedream app slugs; `slack`/`slack_v2` are deliberately absent
 * because Slack ships as a built-in channel, not a catalogue app.
 */
export const CURATED_GROUPS: CuratedGroup[] = [
  {
    id: 'popular',
    label: 'Popular',
    slugs: [
      'gmail',
      'google_calendar',
      'notion',
      'github',
      'linear',
      'google_sheets',
      'hubspot',
      'stripe',
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    slugs: [
      'gmail',
      'microsoft_outlook',
      'discord',
      'zoom',
      'twilio',
      'sendgrid',
      'mailchimp',
      'telegram_bot_api',
    ],
  },
  {
    id: 'productivity',
    label: 'Productivity',
    slugs: [
      'notion',
      'airtable',
      'google_sheets',
      'google_drive',
      'google_docs',
      'google_calendar',
      'trello',
      'asana',
      'clickup',
      'dropbox',
    ],
  },
  {
    id: 'development',
    label: 'Development',
    slugs: ['github', 'gitlab', 'linear', 'jira', 'sentry', 'vercel', 'supabase', 'figma'],
  },
  {
    id: 'sales_support',
    label: 'Sales and support',
    slugs: ['hubspot', 'salesforce', 'pipedrive', 'stripe', 'shopify', 'zendesk', 'intercom'],
  },
];

export interface CatalogueGroup {
  id: string;
  label: string;
  entries: CatalogueEntry[];
  /**
   * True when the group's membership comes from `CURATED_GROUPS` rather than
   * from the project's own data. The UI says so out loud.
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
 * The Discover view: the project's own connectors first, then the curated
 * groups, then everything the curation does not mention. A group with no
 * matching entry is dropped rather than rendered empty.
 */
export function groupCatalogue(
  entries: CatalogueEntry[],
  curated: CuratedGroup[] = CURATED_GROUPS,
): CatalogueGroup[] {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const groups: CatalogueGroup[] = [];

  const connected = entries.filter((entry) => entry.connected);
  if (connected.length > 0) {
    groups.push({ id: 'connected', label: 'Connected', entries: connected, curated: false });
  }

  const filed = new Set<string>();
  for (const group of curated) {
    const matched: CatalogueEntry[] = [];
    for (const slug of group.slugs) {
      const entry = bySlug.get(slug);
      if (entry) matched.push(entry);
    }
    if (matched.length === 0) continue;
    for (const entry of matched) filed.add(entry.slug);
    groups.push({ id: group.id, label: group.label, entries: matched, curated: true });
  }

  const rest = entries.filter((entry) => !filed.has(entry.slug) && !entry.connected);
  if (rest.length > 0) {
    groups.push({ id: 'more', label: 'More connectors', entries: rest, curated: false });
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
