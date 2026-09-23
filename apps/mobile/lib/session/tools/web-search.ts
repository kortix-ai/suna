/**
 * Pure logic behind `components/session/tool/tools/web-search-tool.tsx`.
 *
 * Ported from apps/web `tool/tools/web-search-tool.tsx`: the trigger label
 * (the humanised query, or "N searches"), the "N results" badge, and the flat
 * source list with a query caption only between segments of a multi-query
 * search. Parsing and query humanising come from `@kortix/sdk`.
 */

import { humanizeSearchQuery, type WebSearchQueryResult } from '@kortix/sdk';

export function countWebSearchSources(queryResults: WebSearchQueryResult[]): number {
  return queryResults.reduce((n, q) => n + q.sources.length, 0);
}

/** The row label: what was searched for, never the engine syntax. */
export function webSearchTriggerLabel(queryResults: WebSearchQueryResult[], query: string): string {
  if (queryResults.length === 1) {
    return humanizeSearchQuery(queryResults[0].query) || humanizeSearchQuery(query);
  }
  if (queryResults.length > 1) return `${queryResults.length} searches`;
  return humanizeSearchQuery(query);
}

/** "N results", only for a completed, non-error search with sources. */
export function webSearchTriggerBadge({
  status,
  isError,
  totalSources,
}: {
  status: string;
  isError: boolean;
  totalSources: number;
}): string | undefined {
  if (status !== 'completed' || isError || totalSources <= 0) return undefined;
  return `${totalSources} ${totalSources === 1 ? 'result' : 'results'}`;
}

export interface WebSearchListSegment {
  key: string;
  /** Muted one-line query caption; only on a multi-query search with sources. */
  caption?: string;
  sources: Array<{ url: string; title: string }>;
}

export function webSearchSourceSegments(queryResults: WebSearchQueryResult[]): WebSearchListSegment[] {
  const multi = queryResults.length > 1;
  return queryResults.map((qr, qi) => ({
    key: String(qi),
    caption: multi && qr.sources.length > 0 ? humanizeSearchQuery(qr.query) : undefined,
    sources: qr.sources.map((src) => ({ url: src.url, title: src.title || src.url })),
  }));
}
