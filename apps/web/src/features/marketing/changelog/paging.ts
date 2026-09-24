/* Pure paging helpers. Kept apart from render.ts so the client-side anchor
 * redirect does not pull the markdown pipeline into the browser bundle. */

/** Releases per changelog page. Page 1 is `/changelog`. */
export const CHANGELOG_PAGE_SIZE = 10;

/** The URL of a changelog page; page 1 is the bare `/changelog`. */
export function changelogPageHref(page: number): string {
  return page <= 1 ? '/changelog' : `/changelog/page/${page}`;
}

/**
 * Slices the sorted release list into one page and indexes every tag's page.
 * `items` is `null` for a page outside `1..pageCount` (page 1 always exists,
 * even when empty).
 */
export function paginateReleases<T extends { tag_name: string }>(
  releases: readonly T[],
  page: number,
  pageSize: number = CHANGELOG_PAGE_SIZE,
): { items: T[] | null; pageCount: number; tagPages: Record<string, number> } {
  const pageCount = Math.max(1, Math.ceil(releases.length / pageSize));
  const tagPages: Record<string, number> = {};
  releases.forEach((release, i) => {
    tagPages[release.tag_name] = Math.floor(i / pageSize) + 1;
  });
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    return { items: null, pageCount, tagPages };
  }
  return { items: releases.slice((page - 1) * pageSize, page * pageSize), pageCount, tagPages };
}
