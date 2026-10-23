/**
 * How the Links tab names a link without fetching it: the host ("paper.design")
 * and, as the title, the decoded path ("file/Pricing page"). A link with no
 * path is named by its host.
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
  let raw: string;
  try {
    const { pathname, search } = new URL(url);
    raw = pathname + search;
  } catch {
    return '';
  }
  let text = raw;
  try {
    text = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    // A malformed escape stays as written.
  }
  return text.replace(/^\/+|\/+$/g, '').replace(/\s+/g, ' ').trim();
}

/** The row's title: the title a member gave, else the path, else the host. */
export function linkTitle(link: { url: string; title: string | null }): string {
  return link.title?.trim() || linkPathTitle(link.url) || linkHost(link.url);
}
