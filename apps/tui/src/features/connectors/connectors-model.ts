/**
 * What the `/connectors` screen shows, as pure functions: the list rows (the
 * project's connectors, then the catalogue), each account's line, the access
 * choices with the web's wording, and where `/connect <query>` goes.
 *
 * Every rule a connector or an account follows comes from `@kortix/sdk`
 * (`connectorStatusTone`, `listedConnectorAccounts`,
 * `connectorAccountVisibility`, …). This file only words and orders them.
 */

import {
  type AdminConnector,
  type Connection,
  type ConnectorStatusTone,
  type DiscoverConnector,
  type NewConnectorAccountAudience,
  connectorAccountNeedsSignIn,
  connectorAccountVisibility,
  connectorDisplayName,
  connectorProviderLabel,
  connectorStatusTone,
  listedConnectorAccounts,
} from '@kortix/sdk';

export interface ProjectConnectorRow {
  kind: 'connector';
  /** `c:<slug>`, unique across both groups. */
  id: string;
  slug: string;
  name: string;
  connector: AdminConnector;
  tone: ConnectorStatusTone;
  /** The accounts a person sees (`listedConnectorAccounts`). */
  accounts: Connection[];
}

export interface CatalogRow {
  kind: 'catalog';
  /** `a:<discover id>`. */
  id: string;
  name: string;
  entry: DiscoverConnector;
  /** The project already has a profile for this app. */
  installed: boolean;
}

export type ConnectorsRow = ProjectConnectorRow | CatalogRow;

/** The web's three states (`connectorPages.status*`). */
export const TONE_WORD: Record<ConnectorStatusTone, string> = {
  connected: 'Connected',
  account: 'Needs account',
  error: 'Error',
};

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => field?.toLowerCase().includes(q));
}

/**
 * The project's connectors (name order, filtered by the search) and the
 * catalogue page the server returned for the same search. Channel connectors
 * (Slack, Telegram, …) are listed: they are set up in the web app.
 */
export function connectorsRows(input: {
  connectors: readonly AdminConnector[];
  connections: readonly Connection[] | undefined;
  catalog: readonly DiscoverConnector[];
  search: string;
}): { project: ProjectConnectorRow[]; catalog: CatalogRow[] } {
  const project = input.connectors
    .filter((connector) =>
      matches(input.search, connector.name, connector.slug, connectorProviderLabel(connector.provider)),
    )
    .map((connector): ProjectConnectorRow => {
      const accounts = listedConnectorAccounts(input.connections, connector);
      return {
        kind: 'connector',
        id: `c:${connector.slug}`,
        slug: connector.slug,
        name: connectorDisplayName(connector),
        connector,
        // Before the account list loads the count is unknown, not zero.
        tone: connectorStatusTone(connector, input.connections ? accounts.length : undefined),
        accounts,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const catalog = input.catalog
    // A Kortix built-in that the project already runs is listed above.
    .map(
      (entry): CatalogRow => ({
        kind: 'catalog',
        id: `a:${entry.id}`,
        name: entry.name,
        entry,
        installed: (entry.installed?.length ?? 0) > 0,
      }),
    );
  return { project, catalog };
}

/** The meta line under a project connector row: `2 accounts · 14 tools · Composio`. */
export function connectorMeta(row: ProjectConnectorRow): string {
  const accounts = row.accounts.length;
  const tools = row.connector.actions?.length ?? 0;
  return [
    `${accounts} ${accounts === 1 ? 'account' : 'accounts'}`,
    `${tools} ${tools === 1 ? 'tool' : 'tools'}`,
    connectorProviderLabel(row.connector.provider),
  ].join(' · ');
}

/** How a catalogue entry connects: the web card's quiet line. */
export function catalogKindLabel(entry: Pick<DiscoverConnector, 'kind'>): string {
  switch (entry.kind) {
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

export function catalogMeta(row: CatalogRow): string {
  return [catalogKindLabel(row.entry), row.entry.oneClick ? 'One click' : null, row.entry.categories[0] ?? null]
    .filter(Boolean)
    .join(' · ');
}

/** Who may use an account, as the web row says it (`AudienceText`). */
export function accountAudience(connection: Connection, viewerId: string | null | undefined): string {
  const visibility = connectorAccountVisibility(connection, viewerId);
  if (visibility.kind === 'you') return 'Only you';
  if (visibility.kind === 'everyone') return 'Everyone in workspace';
  const names = visibility.names.join(', ');
  return visibility.more > 0 ? `${names} +${visibility.more}` : names;
}

/** The facts on an account's meta line, in the web row's order. */
export function accountFlags(
  connection: Connection,
  connector: Pick<AdminConnector, 'provider' | 'authSecret'>,
): string[] {
  const active = connection.status === 'active';
  return [
    connection.usable === false ? 'Not shared with you' : null,
    active && connectorAccountNeedsSignIn(connection, connector) ? 'Not signed in' : null,
    active && connection.metadata?.credential_rejected_at ? 'Credential rejected: replace it' : null,
    active ? null : connection.status === 'revoked' ? 'Disconnected' : 'Error',
    connection.connected_as && connection.connected_as !== connection.label
      ? `Connected as ${connection.connected_as}`
      : null,
  ].filter((flag): flag is string => Boolean(flag));
}

export interface AccessChoice {
  id: NewConnectorAccountAudience;
  label: string;
  detail: string;
}

/** "Who can use it": the web's Add account choices (`accessSharing`). */
export function accessChoices(projectName: string | null, purpose: 'create' | 'share'): AccessChoice[] {
  return [
    ...(purpose === 'create'
      ? [{ id: 'private' as const, label: 'Only you', detail: 'Only you can use it, in your private sessions.' }]
      : []),
    {
      id: 'project',
      label: projectName ? `Everyone in ${projectName}` : 'Everyone in workspace',
      detail: 'Everyone with access to the workspace',
    },
    {
      id: 'members',
      label: 'Specific people, groups, or agents',
      detail:
        'Only the people, groups, and agents you pick. People use it in their private sessions; an agent in all its sessions.',
    },
  ];
}

/** May the viewer change this account? Your own, or a shared one when you manage connections. */
export function mayChangeAccount(connection: Connection, canManageConnections: boolean): boolean {
  return connection.owner_type === 'project' ? canManageConnections : connection.owner_type === 'member';
}

export type ConnectTarget =
  | { screen: 'providers'; target: string }
  | { screen: 'connectors'; target: string }
  | null;

/**
 * Where `/connect <query>` goes. A query that names exactly one model
 * provider (by id or label) opens `/providers` on it; anything else opens
 * `/connectors` searching for it. An empty query opens the chooser (`null`).
 */
export function resolveConnectTarget(
  query: string,
  providers: readonly { id: string; label: string }[],
): ConnectTarget {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const hits = providers.filter((provider) => provider.id.toLowerCase() === q || provider.label.toLowerCase() === q);
  if (hits.length === 1) return { screen: 'providers', target: hits[0]!.id };
  return { screen: 'connectors', target: query.trim() };
}

/** The connector's page in the web app (`connectorHref`, no app). */
export function connectorWebPath(projectId: string, slug: string): string {
  return `/workspaces/${encodeURIComponent(projectId)}/admin/connectors/connected/${encodeURIComponent(slug)}`;
}

/** A catalogue app's page in the web app (`appHref`). */
export function catalogWebPath(projectId: string, entry: Pick<DiscoverConnector, 'slug' | 'id'>): string {
  const params = new URLSearchParams({ id: entry.id });
  return `/workspaces/${encodeURIComponent(projectId)}/admin/connectors/${encodeURIComponent(entry.slug)}?${params.toString()}`;
}

/** Break `text` into lines of at most `width` columns, on spaces. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
