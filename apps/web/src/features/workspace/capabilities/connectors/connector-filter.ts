import type { AdminConnector } from '@kortix/sdk';

export type ConnectorScope = 'project' | 'browse' | 'attention';

/**
 * A connector the user has to act on: the server flagged it, or it declares a
 * credential (`authSecret`) that was never set. A connector with no declared
 * credential needs nothing, so an unset secret is not a fault there.
 */
export function connectorNeedsAttention(c: AdminConnector): boolean {
  if (c.status !== 'active') return true;
  return Boolean(c.authSecret) && !c.secretSet;
}

/**
 * Land on what the user most likely came for: their own connectors if they have
 * any, the catalog if the project is empty. Perplexity always opens on Discover,
 * which buries the list for every project past its first day.
 *
 * `browseEnabled` mirrors the project's `connectors_api_discover` flag. Browse
 * reads an experimental catalog, so a project without the flag has no Browse
 * tab at all — and therefore cannot default to it. Such a project lands on its
 * own list instead, which is empty and invites "Add connector". That is
 * truthful: discovery really is off for them.
 *
 * This **fails closed**: `browse` requires an explicit `browseEnabled: true`.
 * An omitted or unknown flag means no browse. Gating an experimental surface
 * is not something a caller should get by forgetting an argument.
 */
export function defaultConnectorScope(
  connectors: readonly AdminConnector[],
  opts: { browseEnabled?: boolean } = {},
): ConnectorScope {
  if (connectors.length > 0) return 'project';
  return opts.browseEnabled === true ? 'browse' : 'project';
}

/**
 * What a connector is called on screen.
 *
 * The grid card, the detail modal header and every string derived from either
 * have to agree, so the fallback lives here rather than being retyped at each
 * site. A connector's `name` is optional and may be whitespace; the slug is
 * the only field guaranteed to be present and non-empty.
 */
export function connectorDisplayName(connector: Pick<AdminConnector, 'name' | 'slug'>): string {
  return connector.name?.trim() || connector.slug;
}

/**
 * A connector card's one-line description: `12 tools · MCP`.
 *
 * `providerLabel` is passed in rather than imported. It lives in
 * `connectors-view.tsx` — a 5,200-line client component — and importing it
 * here would make every consumer of these pure helpers (and every test that
 * touches them) drag that whole tree in. The page supplies
 * `providerLabel(connector.provider)`; this module stays framework-free.
 */
export function connectorSummary(
  connector: Pick<AdminConnector, 'actions'>,
  providerLabel: string,
): string {
  const count = connector.actions.length;
  return `${count} ${count === 1 ? 'tool' : 'tools'} · ${providerLabel}`;
}

/**
 * `describe` is the card's own visible description — the page passes
 * `connectorSummary(...)`, which is what the user is actually reading. Without
 * it, typing `openapi` reported "No matches for openapi" while every card on
 * screen ended in that exact word. Skills (`skill-scope.ts`) and Commands
 * (`command-filter.ts`) already match name + description; this is the same
 * contract.
 *
 * It is a callback rather than a field because the description is composed
 * from `providerLabel`, which lives in `connectors-view.tsx` — a 5,200-line
 * client component this framework-free module must not import. Omitting it
 * narrows the search to slug + name; it never widens it.
 */
export function filterConnectors(
  connectors: readonly AdminConnector[],
  opts: {
    scope: ConnectorScope;
    query: string;
    describe?: (connector: AdminConnector) => string;
  },
): AdminConnector[] {
  if (opts.scope === 'browse') return [];
  const q = opts.query.trim().toLowerCase();
  return connectors.filter((c) => {
    if (opts.scope === 'attention' && !connectorNeedsAttention(c)) return false;
    if (!q) return true;
    return (
      c.slug.toLowerCase().includes(q) ||
      (c.name ?? '').toLowerCase().includes(q) ||
      (opts.describe?.(c) ?? '').toLowerCase().includes(q)
    );
  });
}
