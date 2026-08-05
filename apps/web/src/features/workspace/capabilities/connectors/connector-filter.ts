import type { AdminConnector } from '@kortix/sdk';

/**
 * The three tabs.
 *
 * Two used to be here and are gone for the same reason: a tab that hides part
 * of the list makes the list you are looking at never the whole list.
 *
 * `attention` became a sort key inside `connected` (`compareConnectors`) plus
 * a badge on the card — a connector that needs setting up is still one of your
 * connectors. `available` was the catalogue minus what the project already
 * has, which only ever removed cards the other tabs already mark `✓`; see
 * `SCOPES` in `connectors-page.tsx`.
 */
export type ConnectorScope = 'discover' | 'all' | 'connected';

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
