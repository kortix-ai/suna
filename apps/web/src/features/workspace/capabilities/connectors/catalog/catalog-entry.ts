import type { UiTranslator } from '@/i18n/translator';
import type { AdminConnector, DiscoverConnector, PipedreamApp } from '@kortix/sdk';

import { groupIntoSections, POPULAR_SECTION } from './connector-categories';
import { sortByPicks } from './connector-picks';

/**
 * Which catalogue an entry came from. This is not cosmetic — it decides which
 * add flow the card opens. A `discover` entry goes to `DiscoverAddFlow`
 * (template -> connector draft); an `easy-connect` entry goes to
 * `ConnectorConnectionModal` (managed OAuth via Pipedream). The two build
 * different drafts and cannot be swapped.
 */
export type CatalogSource = 'discover' | 'easy-connect';

interface CatalogEntryFields {
  /** Stable React key. Prefixed by source, because the two catalogues are
   *  independent namespaces and both publish a `slack`. */
  key: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  categories: string[];
  /** Only Discover ranks its catalogue. Easy Connect entries are always
   *  `null`, which keeps them out of the Popular section rather than sorting
   *  them to the bottom of it. */
  popularity: number | null;
}

/**
 * One card in the catalogue, normalised across the two sources so the grid,
 * the search, the category grouping and the connected-state join are written
 * once instead of twice.
 *
 * The raw item rides along on the union arm so the page can hand it straight
 * back to the matching add flow without a lookup.
 */
export type CatalogEntry =
  | (CatalogEntryFields & { source: 'discover'; connector: DiscoverConnector })
  | (CatalogEntryFields & {
      source: 'easy-connect';
      app: PipedreamApp & { provider?: 'composio' | 'pipedream' };
    })
  | (CatalogEntryFields & { source: 'computer' });

/** Native platform provider. The tunnel fleet is its account directory. */
export function computersCatalogEntry(tI18nComplete: UiTranslator): CatalogEntry {
  return {
    source: 'computer',
    key: 'computer:computers',
    slug: 'computers',
    name: 'Computer Tunnels',
    description: tI18nComplete.raw('text070855f4fe8d'),
    icon: null,
    categories: ['developer-tools'],
    popularity: null,
  };
}

export function catalogEntryFromDiscover(connector: DiscoverConnector): CatalogEntry {
  return {
    source: 'discover',
    connector,
    key: `discover:${connector.id}`,
    slug: connector.slug,
    name: connector.name,
    description: connector.description,
    icon: connector.icon,
    categories: connector.categories,
    popularity: connector.popularity,
  };
}

export function catalogEntryFromEasyConnect(
  app: PipedreamApp & { provider?: 'composio' | 'pipedream' },
): CatalogEntry {
  return {
    source: 'easy-connect',
    app,
    key: `easy-connect:${app.slug}`,
    slug: app.slug,
    name: app.name,
    description: app.description,
    icon: app.imgSrc,
    categories: app.categories,
    popularity: null,
  };
}

/**
 * Fold the spellings the two catalogues and the connector list disagree on
 * into one comparable token: `Google Sheets`, `google-sheets` and
 * `google_sheets` all become `googlesheets`.
 */
/**
 * The catalogue kind behind a card, or `null` when the source has none
 * (Easy Connect apps and the native Computers card carry no kind).
 */
export function catalogEntryKind(entry: CatalogEntry): DiscoverConnector['kind'] | null {
  return entry.source === 'discover' ? entry.connector.kind : null;
}

/**
 * MCP servers first, everything else in its existing order — a stable
 * partition, not a re-sort.
 *
 * This is the COR-17 editorial rule: MCP auth got good enough for one-click
 * connect (OAuth discovery + dynamic client registration), so the marketplace
 * leads with MCP. It applies to the sectioned Discovery browse only — the All
 * tab keeps raw feed order on purpose, so one tab stays unopinionated.
 */
export function mcpFirst(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const mcp = entries.filter((entry) => catalogEntryKind(entry) === 'mcp');
  if (mcp.length === 0) return [...entries];
  return [...mcp, ...entries.filter((entry) => catalogEntryKind(entry) !== 'mcp')];
}

export function foldKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The tokens that mean "this project already has it", for the `+` -> `✓` swap
 * on a catalogue card.
 *
 * **This join is best-effort, and deliberately so.** `AdminConnector` does not
 * carry the catalogue app it was created from — `buildEasyConnectConnectorDraft`
 * writes `app: <catalogue slug>` into the draft
 * (`connector-connection-form.ts:156`) but the read model never returns it
 * (`connectors.ts:20-50`). So the only evidence available on the client is the
 * connector's own connection slug and display name.
 *
 * Both are indexed, because the default add flow proposes a connection slug from
 * the app's *name* (`proposeConnectorConnectionSlug(app.name, ...)`), not its
 * slug, and the two differ whenever the catalogue's slug is not a slugified
 * name (`google_sheets` vs "Google Sheets"). Folding both sides covers every
 * default add.
 *
 * What it cannot cover: a connector whose slug AND name were both hand-edited
 * away from the app they came from. That card shows `+` instead of `✓`. The
 * card is still safe to click — the add flow proposes a fresh, non-colliding
 * slug — so the failure mode is a redundant offer, never a broken one. The
 * exact fix is to expose `app` on `AdminConnector`; until then this is the
 * honest ceiling.
 */
export function connectedCatalogKeys(connectors: readonly AdminConnector[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const connector of connectors) {
    // A connector ROW is not a working connection. `needs_auth` means the
    // OAuth handshake never completed — no `connected_account_id`, so every
    // tool call is refused by the gateway. Showing it as connected is the
    // worst possible lie: the user sees a checkmark, the agent gets `needs_auth`
    // on every call, and nothing in the product explains the contradiction.
    // Prod 2026-08-28: all 6 GitHub connections had a null connected account
    // and zero GitHub tool calls had ever executed, while the catalogue showed
    // GitHub as connected.
    //
    // `error` stays connected-looking on purpose: the credential exists and the
    // card's own error affordance is what surfaces the problem. Only the
    // never-authorized case is a false checkmark.
    if (connector.status === 'needs_auth') continue;
    keys.add(`provider:${connector.provider}`);
    keys.add(foldKey(connector.slug));
    if (connector.name?.trim()) keys.add(foldKey(connector.name));
  }
  keys.delete('');
  return keys;
}

/**
 * Does a connector token (folded slug or name) identify this entry token?
 *
 * Exact match, or the connector token EXTENDS the entry's — the default add
 * flows propose names like "Canva MCP server" / "Canva MCP server 2", which
 * fold to `canvamcpserver…` and share only a PREFIX with the entry's `canva`.
 * Exact-only matching read every such connector as unrelated, so the Canva
 * card offered `+` and the Canva page listed nothing while the project held
 * two Canva servers. Prefix only counts for entry tokens of 4+ characters, so
 * a short entry ("Git") cannot claim everything that merely starts with it
 * (github, gitlab).
 */
function tokenIdentifiesEntry(connectorToken: string, entryToken: string): boolean {
  if (!entryToken || !connectorToken) return false;
  if (connectorToken === entryToken) return true;
  return entryToken.length >= 4 && connectorToken.startsWith(entryToken);
}

function catalogEntryTokens(entry: CatalogEntry): string[] {
  return [foldKey(entry.slug), foldKey(entry.name)].filter(Boolean);
}

export function isCatalogEntryConnected(
  entry: CatalogEntry,
  connectedKeys: ReadonlySet<string>,
): boolean {
  if (entry.source === 'computer') return connectedKeys.has('provider:computer');
  const tokens = catalogEntryTokens(entry);
  // The set stays the cheap exact index; the prefix pass iterates it — two
  // keys per connector, dozens of connectors, ~72 cards: trivial.
  for (const token of tokens) {
    if (connectedKeys.has(token)) return true;
  }
  for (const key of connectedKeys) {
    if (tokens.some((token) => tokenIdentifiesEntry(key, token))) return true;
  }
  return false;
}

/**
 * Every project connector created from this catalogue entry — the membership
 * list behind a detail page's "In this project" section. Unlike
 * {@link connectedCatalogKeys} it does NOT skip `needs_auth` rows: this is
 * "what exists", not "what works" — a half-connected connector belongs in the
 * list with its status line saying so.
 */
export function catalogEntryConnectors(
  connectors: readonly AdminConnector[],
  entry: CatalogEntry,
): AdminConnector[] {
  if (entry.source === 'computer') {
    return connectors.filter((connector) => connector.provider === 'computer');
  }
  const tokens = catalogEntryTokens(entry);
  return connectors.filter((connector) =>
    [foldKey(connector.slug), foldKey(connector.name ?? '')].some((connectorToken) =>
      tokens.some((token) => tokenIdentifiesEntry(connectorToken, token)),
    ),
  );
}

/** The synthetic first section. Not a catalogue category — see
 *  `catalogSections` below. Defined in `connector-categories.ts` (which this
 *  module already imports from, so it cannot import back) and re-exported here
 *  because this is where it is used. */
export { POPULAR_SECTION };

/**
 * The catalogue as ordered sections: Popular first, then the curated browse
 * order (`groupIntoSections`, which is `CURATED_SECTIONS` then the uncurated
 * tail by size then `Other`).
 *
 * Popular stays above all of it because it is not a category — it is the
 * highest-ranked apps across every category, which is the one row that answers
 * "what do people actually connect?" before the user has picked a subject. It
 * only exists on the Discover source; Easy Connect ranks nothing, so there
 * Productivity leads.
 *
 * Popular is synthesised rather than read as a category, because `popularity`
 * is a per-item rank and no catalogue publishes a "popular" bucket. Entries in
 * it are NOT removed from their real sections — an app is both popular and a
 * developer tool, and hiding it from Developer tools to avoid repeating it
 * would make that section lie about what it contains. `groupIntoSections`
 * already duplicates items across the sections they claim, so this is the same
 * rule applied one level up.
 *
 * A section is emitted only when it has entries, so a catalogue with no ranked
 * items (Easy Connect, whose `popularity` is uniformly `null`) simply has no
 * Popular section instead of an empty heading.
 */
export function catalogSections(
  entries: readonly CatalogEntry[],
  opts: {
    popularCap: number;
    /** Key sections by the catalogue's own category slug rather than the curated
     *  bucket. Set for any source whose sections are opened by asking the server
     *  for that key — see `sectionKeysForEntry`. */
    rawCategoryKeys?: boolean;
  },
): Array<{ category: string; items: CatalogEntry[] }> {
  const ranked = mcpFirst(
    entries
      .filter((entry) => entry.popularity !== null)
      .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
      .slice(0, opts.popularCap),
  );

  // Picks are applied HERE and nowhere else, which scopes them to the Discovery
  // tab: this is the only caller that builds sections. The All tab reads
  // `groupIntoSections` directly and keeps raw feed order, so the two tabs
  // never disagree about what "first" means — one is opinionated, one is not.
  //
  // `mcpFirst` rides on top of both orderings (COR-17): within Popular and
  // within each section, MCP servers lead and the existing ranking (popularity,
  // then picks) decides the order inside each half. A stable partition, so the
  // real rankings survive intact on both sides of the split.
  const sections = groupIntoSections(entries, (entry) => entry.categories, {
    raw: opts.rawCategoryKeys,
  }).map((section) => ({
    category: section.category,
    items: mcpFirst(sortByPicks(section.category, section.items)),
  }));
  return ranked.length > 0 ? [{ category: POPULAR_SECTION, items: ranked }, ...sections] : sections;
}
