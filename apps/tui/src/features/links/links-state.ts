/**
 * The Links panel's rows: every URL noticed in this session, newest first.
 *
 * Pure functions over an ordered map so the panel's ordering and its cap are
 * asserted without a renderer. A URL seen again moves to the top — the link a
 * CLI just re-printed is the one the user is after.
 */

export type LinkSource = 'transcript' | 'terminal';

export interface LinkRow {
  url: string;
  source: LinkSource;
}

/** Rows the panel keeps. A session that prints thousands of URLs is a log, not a link list. */
export const MAX_LINK_ROWS = 200;

/** `rows` with `urls` from `source` moved to the front, in the order given, capped. */
export function withLinks(
  rows: readonly LinkRow[],
  urls: readonly string[],
  source: LinkSource,
): LinkRow[] {
  if (urls.length === 0) return [...rows];
  const fresh = new Set(urls);
  const kept = rows.filter((row) => !fresh.has(row.url));
  const added: LinkRow[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    added.push({ url, source });
  }
  return [...added, ...kept].slice(0, MAX_LINK_ROWS);
}

/** True when `next` would leave `rows` unchanged, so state need not update. */
export function sameLinks(rows: readonly LinkRow[], next: readonly LinkRow[]): boolean {
  if (rows.length !== next.length) return false;
  return rows.every(
    (row, index) => row.url === next[index]?.url && row.source === next[index]?.source,
  );
}
