import type { MarketplaceItem } from '@/lib/marketplace-client';
import { TYPE_SECTIONS } from './marketplace-meta';

/** Card columns per virtualized grid row (matches `md:grid-cols-3` in the CSS
 *  grid below). Row height is corrected post-render via `measureElement`, so
 *  a fixed chunk size stays correct across breakpoints (a 3-item chunk stacks
 *  into a taller single virtual row on mobile's 1-column layout). */
export const MARKETPLACE_GRID_COLUMNS = 3;

export type MarketplaceGridRow =
  | { kind: 'header'; label: string; count: number }
  | { kind: 'items'; items: MarketplaceItem[] };

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Groups items by their `TYPE_SECTIONS` label, preserving section order and
 *  bucketing anything unmatched into "Other". Extracted from the old
 *  `sections` useMemo so it's independently testable. */
export function groupMarketplaceItemsByType(
  items: MarketplaceItem[],
): { label: string; items: MarketplaceItem[] }[] {
  const byLabel = new Map<string, MarketplaceItem[]>();
  for (const it of items) {
    const label = TYPE_SECTIONS.find((s) => s.type === it.type)?.label ?? 'Other';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(it);
  }
  const order = [...new Set(TYPE_SECTIONS.map((s) => s.label)), 'Other'];
  return [...byLabel.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([label, list]) => ({ label, items: list }));
}

/** Flattens items (grouped or not) into virtualizer rows: a header row per
 *  type section (when `grouped`) followed by fixed-size item chunks, or a
 *  flat chunked list when not grouped (active search/type/source filter).
 *  This is the row set fed to `useVirtualizer({ count: rows.length })` so
 *  only a bounded window of DOM nodes is ever mounted regardless of how many
 *  pages have loaded. */
export function buildMarketplaceGridRows(params: {
  items: MarketplaceItem[];
  grouped: boolean;
  columns?: number;
}): MarketplaceGridRow[] {
  const columns = params.columns ?? MARKETPLACE_GRID_COLUMNS;
  if (!params.grouped) {
    return chunk(params.items, columns).map((items) => ({ kind: 'items', items }) as const);
  }
  const rows: MarketplaceGridRow[] = [];
  for (const section of groupMarketplaceItemsByType(params.items)) {
    rows.push({ kind: 'header', label: section.label, count: section.items.length });
    for (const items of chunk(section.items, columns)) rows.push({ kind: 'items', items });
  }
  return rows;
}

/** Stable virtualizer key for a grid row — content-based so appended pages
 *  (which only grow the tail) don't force React to re-key unrelated rows. */
export function marketplaceGridRowKey(row: MarketplaceGridRow, index: number): string {
  if (row.kind === 'header') return `header:${row.label}`;
  return `items:${row.items.map((i) => i.id).join(',') || index}`;
}

/** Resolves the type filter to `'all'` if the current selection is no longer
 *  a valid option (e.g. it dropped out of `typeOptions` after a source
 *  change). Extracted from an inline expression for testability. */
export function resolveEffectiveMarketplaceType(
  type: string,
  typeOptions: { value: string }[],
): string {
  return typeOptions.some((t) => t.value === type) ? type : 'all';
}

/** Decides whether the bottom sentinel intersecting should trigger
 *  `fetchNextPage()` — only when it's actually in view, there's a next page,
 *  and a fetch isn't already in flight. Extracted so the paging decision is
 *  unit-testable without a real `IntersectionObserver`. */
export function shouldFetchNextMarketplacePage(
  isIntersecting: boolean,
  query: { hasNextPage: boolean; isFetchingNextPage: boolean },
): boolean {
  return isIntersecting && query.hasNextPage && !query.isFetchingNextPage;
}

/** The params passed to `useInfiniteMarketplaceItems` from the browser's
 *  search/type/source controls. Extracted so control changes re-scoping the
 *  query is testable as a pure mapping, independent of react-query. */
export function resolveMarketplaceQueryParams(controls: {
  debounced: string;
  effectiveType: string;
  source: string;
  publicOnly: boolean;
}): { query: string; type: string; source: string; publicOnly: boolean } {
  return {
    query: controls.debounced,
    type: controls.effectiveType,
    source: controls.source,
    publicOnly: controls.publicOnly,
  };
}

/** Top-level view the public explore landing renders (A4). An empty catalog
 *  wins even mid-search (nothing to search); otherwise a query in flight
 *  switches the whole page to the paged/virtualized search view instead of
 *  the grouped preview sections. "No results for this search" isn't decided
 *  here — it's only knowable once the paged query resolves, so it's handled
 *  by the paged grid itself. */
export type MarketplaceExploreViewMode = 'empty' | 'search' | 'browse';

export function resolveMarketplaceExploreViewMode(params: {
  catalogEmpty: boolean;
  searching: boolean;
}): MarketplaceExploreViewMode {
  if (params.catalogEmpty) return 'empty';
  if (params.searching) return 'search';
  return 'browse';
}

/** Sums a `MarketplaceSummary[]`'s per-type counts across all sources into a
 *  single map, keyed by the short type name (`skill`, not `registry:skill`)
 *  as the summaries report them. Used to size the "See all N" affordance
 *  from cheap, already-fetched summary counts instead of the SSR-bounded
 *  item page (A4) — the bounded page alone can't say whether a type has more
 *  items than made it into that page. */
export function sumMarketplaceTypeCounts(
  marketplaces: { types?: Record<string, number> }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of marketplaces) {
    for (const [k, v] of Object.entries(m.types ?? {})) counts[k] = (counts[k] ?? 0) + v;
  }
  return counts;
}

/** Whether the paged grid (A4's `MarketplacePagedGrid`) should render its
 *  windowed/virtualized layout instead of a plain grid of the current items.
 *  Only true once more than one page has actually loaded client-side —
 *  gating on this (rather than item/row count) guarantees the first page is
 *  always rendered the same, deterministic way on the server and on first
 *  hydration, since a fetched page count > 1 is only reachable after a real
 *  post-hydration scroll. A single page is also small enough (bounded by the
 *  configured page size) to mount directly without windowing. */
export function shouldVirtualizeMarketplacePagedGrid(pageCount: number): boolean {
  return pageCount > 1;
}

/** Resolves a type section's true item total from the summed type counts
 *  (stripping the `registry:` prefix to match their short keys), falling
 *  back to the SSR-bounded local count when the type is absent from the
 *  summary (e.g. no marketplaces loaded yet). */
export function resolveMarketplaceTypeSectionTotal(
  type: string,
  typeCounts: Record<string, number>,
  localCount: number,
): number {
  const total = typeCounts[type.replace(/^registry:/, '')];
  return typeof total === 'number' ? total : localCount;
}
