/**
 * LSS (Local Semantic Search) API — semantic search via the Kortix Master endpoint.
 *
 * Calls the `/lss/search` route on Kortix Master, which spawns the `lss` CLI
 * (BM25 + embeddings) and returns JSON results with file paths, scores, and snippets.
 */

import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { getAuthToken } from '@/lib/auth-token';
import type { LssHit, LssSearchResult } from '../types';

/**
 * Search workspace files using semantic search (BM25 + embeddings).
 *
 * @param query - Natural language search query
 * @param options - Optional parameters for limit, path scope, and extension filters
 * @returns Flattened array of search hits sorted by relevance
 */
export async function searchLss(
  query: string,
  options?: {
    limit?: number;
    path?: string;
    ext?: string;
  },
): Promise<LssHit[]> {
  const serverUrl = getActiveOpenCodeUrl();

  // Build search URL — the server URL points to Kortix Master (port 8000),
  // and the /lss/search route is mounted directly on it.
  const params = new URLSearchParams({ q: query });
  if (options?.limit) params.set('k', String(options.limit));
  if (options?.path) params.set('path', options.path);
  if (options?.ext) params.set('ext', options.ext);

  const url = `${serverUrl.replace(/\/+$/, '')}/lss/search?${params.toString()}`;

  // Inject auth header (same pattern as the SDK client)
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });

    if (!response.ok) {
      console.warn(`[lss-search] HTTP ${response.status}: ${response.statusText}`);
      return [];
    }

    // Guard against non-JSON responses (e.g. the dev server returning an HTML page
    // when the /lss/search route doesn't exist on this server).
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      console.warn(`[lss-search] Expected JSON but got "${contentType}" — endpoint may not be available`);
      return [];
    }

    const data: LssSearchResult[] | { error: string } = await response.json();

    // Handle error responses
    if ('error' in data) {
      console.warn('[lss-search] Server error:', data.error);
      return [];
    }

    // Flatten hits from all query results (usually just one query)
    return data.flatMap((r) => r.hits ?? []);
  } catch (error) {
    // Silently return empty on network errors, timeouts, etc.
    // The command palette still works with sessions and file name search.
    console.warn('[lss-search] Request failed:', error);
    return [];
  }
}
