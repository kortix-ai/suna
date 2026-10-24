import type { AdminConnector } from '@kortix/sdk';

/**
 * The Connectors page tabs, held in `?scope=`:
 * - `connectors`: the project's own connectors (the landing tab, no param);
 * - `browse`: the catalogue, to add one;
 * - `channels`: what Kortix built for people to reach the agent (Slack, Teams,
 *   email, Telegram, the computer);
 * - `rules`: the project's approval rules and who gets which rule set.
 *
 * `all` and `connected` are the old spellings of `browse` and `connectors`;
 * `?rules=1` is the old spelling of `rules`. `parseConnectorScope` maps them.
 */
export type ConnectorScope = 'connectors' | 'browse' | 'channels' | 'rules';

export const CONNECTOR_SCOPES: readonly ConnectorScope[] = ['connectors', 'browse', 'channels', 'rules'];

const LEGACY_SCOPE: Record<string, ConnectorScope> = { all: 'browse', connected: 'connectors' };

/** `?scope=` (and the old `?rules=1`) as a tab. Anything unknown is Connectors. */
export function parseConnectorScope(search: Pick<URLSearchParams, 'get'> | null | undefined): ConnectorScope {
  // `tab=` is how an API `setup_url` spells it.
  const value = search?.get('scope') ?? search?.get('tab') ?? '';
  if (search?.get('rules') === '1') return 'rules';
  return CONNECTOR_SCOPES.find((scope) => scope === value) ?? LEGACY_SCOPE[value] ?? 'connectors';
}

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
 * Anything the user has to act on floats to the top; everything else is
 * alphabetical.
 *
 * This is what replaced the Needs-attention tab. A tab hid the healthy
 * connectors from the broken ones and vice versa, and forced a choice about
 * which list you were reading. Sorting keeps one list and still puts the
 * broken ones where the eye lands first, next to the badge that says why.
 *
 * `localeCompare` rather than `<`, so `Ärendehantering` sorts next to `A…`
 * instead of after `Z…`.
 */
export function compareConnectors(a: AdminConnector, b: AdminConnector): number {
  const attention = Number(connectorNeedsAttention(b)) - Number(connectorNeedsAttention(a));
  if (attention !== 0) return attention;
  return connectorDisplayName(a).localeCompare(connectorDisplayName(b));
}

/**
 * The project's own connectors, narrowed by the search box and ordered by
 * `compareConnectors`.
 *
 * There is no `scope` parameter any more. The three catalogue tabs are served
 * by `useCatalog`, which searches server-side across the whole catalogue —
 * only this list is filtered on the client, because it is fully loaded.
 *
 * `describe` is the card's own visible description — the page passes
 * `connectorSummary(...)`, which is what the user is actually reading. Without
 * it, typing `openapi` reported "No matches for openapi" while every card on
 * screen ended in that exact word. Skills (`skill-scope.ts`) and Commands
 * (`command-filter.ts`) already match name + description; this is the same
 * contract. Omitting it narrows the search to slug + name; it never widens it.
 */
export function filterConnectors(
  connectors: readonly AdminConnector[],
  opts: {
    query: string;
    describe?: (connector: AdminConnector) => string;
  },
): AdminConnector[] {
  const q = opts.query.trim().toLowerCase();
  const matched = connectors.filter((c) => {
    if (!q) return true;
    return (
      c.slug.toLowerCase().includes(q) ||
      (c.name ?? '').toLowerCase().includes(q) ||
      (opts.describe?.(c) ?? '').toLowerCase().includes(q)
    );
  });
  return matched.sort(compareConnectors);
}
