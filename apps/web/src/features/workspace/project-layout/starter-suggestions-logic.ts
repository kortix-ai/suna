/**
 * Pure paging math for the starter-suggestion rows under the hero composer.
 * `pageSize` is fixed at 3 by the caller (see `starter-suggestions.tsx`) —
 * this module stays generic so the tests pin the arithmetic, not the constant.
 */

/** How many pages a pool of `poolLength` items splits into at `pageSize` per page. */
export function pageCount(poolLength: number, pageSize: number): number {
  return Math.ceil(poolLength / pageSize);
}

/** The items visible on `page` (0-indexed). Out-of-range pages render nothing. */
export function sliceForPage<T>(pool: T[], page: number, pageSize: number): T[] {
  return pool.slice(page * pageSize, page * pageSize + pageSize);
}

/** Advances to the next page, wrapping around. A no-op below 2 pages. */
export function nextPage(page: number, pages: number): number {
  if (pages <= 1) return page;
  return (page + 1) % pages;
}
