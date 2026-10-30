import type { AdminConnector, ConnectToolkit, DiscoverConnector, PipedreamApp } from '@kortix/sdk';

import { faviconUrlForHostname } from '../../../lib/favicon';
import { discoverLogoSource, type ConnectorLogoSource } from '../../../internal/connector-logo/connector-logo-source';

import { POPULAR_SECTION } from './connector-categories';

interface CatalogEntryFields {
  /** Stable React key: `discover:<record id>`. */
  key: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  categories: string[];
  /** The catalogue's rank; `null` keeps a record out of the Popular section. */
  popularity: number | null;
}

/**
 * One card in the catalogue: a Discover record (Kortix apps, integrations.sh
 * servers and APIs, Composio apps). The raw record rides along so the page can
 * hand it straight to the install flow without a lookup.
 */
export type CatalogEntry = CatalogEntryFields & {
  source: 'discover';
  connector: DiscoverConnector;
};

/**
 * The icon URL a Discover record's card loads.
 *
 * A share of the catalogue's records carry a `domain` and no `icon` — the
 * upstream feed only holds a logo for entries it could scrape one for. The
 * card for such a record used to fall straight to a generic globe glyph, which
 * is exactly the "inconsistent or missing imagery" a connector catalogue
 * should not show when the app's own favicon is one well-known URL away. The
 * same favicon service the marketing connectors page and `FaviconAvatar`
 * already use resolves it; where the domain is a pseudo-host (`*.local`, the
 * apis.guru feed's placeholders) it answers the generic globe image, which
 * reads the same as the glyph it replaced.
 */
export function discoverEntryIcon(
  connector: Pick<DiscoverConnector, 'icon' | 'domain'>,
): string | null {
  return connector.icon ?? faviconUrlForHostname(connector.domain);
}

export type EasyConnectApp = PipedreamApp & { provider?: 'composio' | 'pipedream' };

/** A Composio toolkit as the card the Easy Connect grid renders. The paged
 *  catalogue and the browse sections both use this, so a card is identical in
 *  a section and behind its "View all". */
export function connectToolkitApp(toolkit: ConnectToolkit): EasyConnectApp {
  return {
    slug: toolkit.slug,
    name: toolkit.name,
    description: toolkit.description ?? null,
    imgSrc: toolkit.logo,
    authType: toolkit.isNoAuth ? 'none' : 'oauth',
    categories: toolkit.categories ?? [],
    hasActions: true,
    hasTriggers: false,
    featuredWeight: 0,
    provider: 'composio',
    directId: toolkit.directId ?? null,
    directMcpUrl: toolkit.directMcpUrl ?? null,
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
    icon: discoverEntryIcon(connector),
    categories: connector.categories,
    popularity: connector.popularity,
  };
}

/**
 * The one fact that varies between cards: HOW this entry connects. Short
 * nouns, shown as the card's quiet line under the title — every card gets
 * one, so the rows scan as a consistent column.
 */
/**
 * One key per app across both catalogues: lower case, letters and digits only,
 * a trailing "MCP" dropped, so `Linear`, `Linear MCP` and `linear` match. The
 * API joins managed apps to API/MCP entries with the same rule
 * (`apps/api/src/connectors/connect-direct-twins.ts`).
 */
export function appNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(mcp|mcpserver)$/, '');
}

export function catalogEntryKindLabel(entry: CatalogEntry): string {
  switch (entry.connector.kind) {
    case 'composio':
      return 'Composio';
    case 'kortix':
      return 'Kortix';
    case 'mcp':
      return 'MCP';
    case 'graphql':
      return 'GraphQL';
    default:
      return 'API';
  }
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

export function isCatalogEntryConnected(
  entry: CatalogEntry,
  connectedKeys: ReadonlySet<string>,
): boolean {
  return connectedKeys.has(foldKey(entry.slug)) || connectedKeys.has(foldKey(entry.name));
}

/**
 * A connector token names an entry when it equals the entry's token, or starts
 * with it. The prefix pass exists because a default add is named `<App>` then
 * `<App> 2`, and its slug is `<app>-<random>`: neither equals the app's token.
 * It only counts for entry tokens of 4+ characters, so "Git" cannot claim
 * "GitHub".
 */
function tokenIdentifiesEntry(connectorToken: string, entryToken: string): boolean {
  if (!entryToken || !connectorToken) return false;
  if (connectorToken === entryToken) return true;
  return entryToken.length >= 4 && connectorToken.startsWith(entryToken);
}

/**
 * Every project connector that reads as created from this catalogue entry:
 * the app page's "In this project" list. It does not skip `needs_auth` rows —
 * this is "what exists", and the row's status line says what is missing.
 *
 * DISPLAY ONLY. It is lenient, so a wrong answer is a wrong row in a list.
 * Install reuse must not use it: see `connectorInstalledFrom` in
 * `install/install.ts`.
 */
export function catalogEntryConnectors(
  connectors: readonly AdminConnector[],
  entry: CatalogEntry,
): AdminConnector[] {
  const tokens = [foldKey(entry.slug), foldKey(entry.name)].filter(Boolean);
  return connectors.filter((connector) =>
    [foldKey(connector.slug), foldKey(connector.name ?? '')].some((connectorToken) =>
      tokens.some((token) => tokenIdentifiesEntry(connectorToken, token)),
    ),
  );
}

/** The synthetic first browse section. Not a catalogue category — see
 *  `browseSections` in `browse-sections.ts`. Defined in `connector-categories.ts`
 *  and re-exported here for the modules that already import this one. */
export { POPULAR_SECTION };

/** The logo source of a catalogue card (`ConnectorLogo`): same rule as every other surface. */
export function catalogEntryLogoSource(entry: CatalogEntry): ConnectorLogoSource {
  return discoverLogoSource(entry.connector);
}
