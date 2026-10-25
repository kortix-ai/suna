/**
 * How the Links tab names a link: the server's title when it has one, else,
 * without fetching it, the decoded path ("file/Pricing page") under the host
 * ("paper.design"). A link with no path is named by its host.
 */

/** The host without `www.`; the raw text when it does not parse. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The path and query, decoded, without the outer slashes; '' for a bare host. */
export function linkPathTitle(url: string): string {
  let pathname: string;
  let search: string;
  try {
    ({ pathname, search } = new URL(url));
  } catch {
    return '';
  }
  // `+` means a space in a query only; in a path it is a plus (`wiki/C++`).
  const text = decode(pathname) + decode(search.replace(/\+/g, ' '));
  return text.replace(/^\/+|\/+$/g, '').replace(/\s+/g, ' ').trim();
}

/** A malformed escape stays as written. */
function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The row's title: the server's `display_title` (the title a member gave, else
 * the page's fetched title), else the title a member gave, else the path, else the host.
 */
export function linkTitle(link: { url: string; title: string | null; display_title?: string | null }): string {
  return link.display_title?.trim() || link.title?.trim() || linkPathTitle(link.url) || linkHost(link.url);
}

/** The Added filter's windows: the Threads tab's Activity values. */
export const LINK_ADDED = ['today', 'last7', 'last30'] as const;
export type LinkAdded = (typeof LINK_ADDED)[number];

/**
 * The Links tab's search and filters, as the URL holds them
 * (`?q=&pinned=1&by=&added=`). `by` is `me` or a user id.
 */
export interface LinkFilters {
  q: string;
  pinned: boolean;
  by: string | null;
  added: LinkAdded | null;
}

export function linkFiltersFromParams(params: { get(name: string): string | null }): LinkFilters {
  const added = params.get('added');
  return {
    q: params.get('q')?.trim() ?? '',
    pinned: params.get('pinned') === '1',
    by: params.get('by') || null,
    added: LINK_ADDED.find((value) => value === added) ?? null,
  };
}

/** Local midnight today, 6 days earlier (7 days with today) or 29 days earlier. */
function linkAddedSince(added: LinkAdded, now: Date): number {
  const days = added === 'today' ? 0 : added === 'last7' ? 6 : 29;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
}

type FilterableLink = {
  url: string;
  title: string | null;
  display_title?: string | null;
  site_name?: string | null;
  pinned: boolean;
  created_by: string | null;
  last_shared_at: string;
};

/**
 * The links that match: the search reads the title, the site name, the host and
 * the URL (case-insensitive); `by: 'me'` reads `viewerId`; Added reads the last share.
 */
export function filterLinks<T extends FilterableLink>(
  links: readonly T[],
  filters: LinkFilters,
  viewerId: string | undefined,
  now: Date,
): T[] {
  const q = filters.q.toLowerCase();
  const by = filters.by === 'me' ? viewerId : filters.by;
  const since = filters.added ? linkAddedSince(filters.added, now) : null;
  return links.filter(
    (link) =>
      (!filters.pinned || link.pinned) &&
      (!filters.by || link.created_by === by) &&
      (since === null || Date.parse(link.last_shared_at) >= since) &&
      (!q || [linkTitle(link), link.site_name ?? '', linkHost(link.url), link.url].some((text) => text.toLowerCase().includes(q))),
  );
}
