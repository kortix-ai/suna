import type { MarketplaceItem } from '@/lib/marketplace-client';
import { TYPE_SECTIONS } from './marketplace-meta';

/** Card columns per virtualized grid row (matches `md:grid-cols-3` in the CSS
 *  grid below). Row height is corrected post-render via `measureElement`, so
 *  a fixed chunk size stays correct across breakpoints (a 3-item chunk stacks
 *  into a taller single virtual row on mobile's 1-column layout). */
export const MARKETPLACE_GRID_COLUMNS = 3;

export type MarketplaceGridRow = { kind: 'items'; items: MarketplaceItem[] };

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Flattens paged `{ items }[]` (react-query's `infiniteQuery.data.pages`)
 *  into a single item list, keeping only the first occurrence of each `id`.
 *  The catalog re-sorts alphabetically as external sources stream in during
 *  cold load, so page-seam offsets can shift between fetches — a plain
 *  `pages.flatMap(p => p.items)` can then yield the same `item.id` twice
 *  (duplicate React keys) or, less visibly, skip one. De-duping here is cheap
 *  insurance; the poll while `loading` still heals ordering once streaming
 *  settles. */
export function flattenMarketplaceItems(pages: { items: MarketplaceItem[] }[]): MarketplaceItem[] {
  const seen = new Set<string>();
  const out: MarketplaceItem[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/** Groups items by their `TYPE_SECTIONS` label, preserving section order and
 *  bucketing anything unmatched into "Other". Extracted from the old
 *  `sections` useMemo so it's independently testable. Also reused by the project
 *  detail to render a project's contents in the same typed sections + grid as
 *  the marketplace gallery. */
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

/** Flattens items into fixed-size virtualizer rows. */
export function buildMarketplaceGridRows(params: {
  items: MarketplaceItem[];
  columns?: number;
}): MarketplaceGridRow[] {
  const columns = params.columns ?? MARKETPLACE_GRID_COLUMNS;
  return chunk(params.items, columns).map((items) => ({ kind: 'items', items }) as const);
}

/** Stable virtualizer key for a grid row — content-based so appended pages
 *  (which only grow the tail) don't force React to re-key unrelated rows. */
export function marketplaceGridRowKey(row: MarketplaceGridRow, index: number): string {
  return `items:${row.items.map((i) => i.id).join(',') || index}`;
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
