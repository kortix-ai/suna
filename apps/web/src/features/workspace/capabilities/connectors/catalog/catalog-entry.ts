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
  | (CatalogEntryFields & { source: 'easy-connect'; app: PipedreamApp })
  | (CatalogEntryFields & { source: 'computer' });

/** Native platform provider. The tunnel fleet is its account directory. */
export function computersCatalogEntry(): CatalogEntry {
  return {
    source: 'computer',
    key: 'computer:computers',
    slug: 'computers',
    name: 'Computers',
    description:
      'Connect Macs, Windows PCs, and Linux machines through the secure Kortix Agent Tunnel, then choose which machines agents can access.',
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

export function catalogEntryFromEasyConnect(app: PipedreamApp): CatalogEntry {
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
    keys.add(`provider:${connector.provider}`);
    keys.add(foldKey(connector.slug));
    if (connector.name?.trim()) keys.add(foldKey(connector.name));
  }
  keys.delete('');
  return keys;
}

export function isCatalogEntryConnected(
  entry: CatalogEntry,
  connectedKeys: ReadonlySet<string>,
): boolean {
  if (entry.source === 'computer') return connectedKeys.has('provider:computer');
  return connectedKeys.has(foldKey(entry.slug)) || connectedKeys.has(foldKey(entry.name));
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
  opts: { popularCap: number },
): Array<{ category: string; items: CatalogEntry[] }> {
  const ranked = entries
    .filter((entry) => entry.popularity !== null)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, opts.popularCap);

  // Picks are applied HERE and nowhere else, which scopes them to the Discovery
  // tab: this is the only caller that builds sections. The All tab reads
  // `groupIntoSections` directly and keeps raw feed order, so the two tabs
  // never disagree about what "first" means — one is opinionated, one is not.
  //
  // Popular is deliberately left alone. It is already ordered, by `popularity`,
  // and re-sorting it by picks would replace a real ranking with a guess.
  const sections = groupIntoSections(entries, (entry) => entry.categories).map((section) => ({
    category: section.category,
    items: sortByPicks(section.category, section.items),
  }));
  return ranked.length > 0 ? [{ category: POPULAR_SECTION, items: ranked }, ...sections] : sections;
}
