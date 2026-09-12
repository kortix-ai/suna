import type { UiTranslator } from '@/i18n/translator';
import type { AdminConnector, DiscoverConnector, PipedreamApp } from '@kortix/sdk';


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
 * The one fact that varies between cards: HOW this entry connects. Short
 * nouns, shown as the card's quiet line under the title — every card gets
 * one, so the rows scan as a consistent column instead of some cards
 * carrying a mark and others nothing.
 */
export function catalogEntryKindLabel(entry: CatalogEntry): string {
  if (entry.source === 'computer') return 'Native';
  if (entry.source === 'easy-connect') return 'App';
  switch (entry.connector.kind) {
    case 'mcp':
      return 'MCP';
    case 'graphql':
      return 'GraphQL';
    case 'cli':
      return 'CLI';
    default:
      return 'API';
  }
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
/**
 * The inverse of {@link catalogEntryConnectors}: given catalogue items, which
 * one does this CONNECTOR belong to? Same prefix rule, same direction — the
 * connector token extends the app token ("canvamcpserver" extends "canva") —
 * so the two joins cannot disagree about membership.
 */
export function catalogAppForConnector<T extends { slug: string; name: string }>(
  items: readonly T[],
  connector: Pick<AdminConnector, 'slug' | 'name'>,
): T | null {
  const connectorTokens = [foldKey(connector.slug), foldKey(connector.name ?? '')].filter(Boolean);
  return (
    items.find((item) =>
      [foldKey(item.slug), foldKey(item.name)]
        .filter(Boolean)
        .some((token) =>
          connectorTokens.some((connectorToken) => tokenIdentifiesEntry(connectorToken, token)),
        ),
    ) ?? null
  );
}

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

