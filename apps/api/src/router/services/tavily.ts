import { config } from '../../config';
import type { WebSearchResult } from '../../types';

interface CrwSearchResult {
  url: string;
  title: string;
  description: string;
  score?: number;
  publishedDate?: string;
}

interface CrwSearchResponse {
  success: boolean;
  data: CrwSearchResult[] | { web?: CrwSearchResult[] };
  error?: string;
}

/**
 * Search the web using CRW API (with Tavily fallback).
 *
 * @param query - Search query
 * @param maxResults - Maximum number of results (1-10)
 * @param searchDepth - "basic" or "advanced"
 * @returns List of WebSearchResult
 */
export async function webSearchTavily(
  query: string,
  maxResults: number = 5,
  searchDepth: 'basic' | 'advanced' = 'basic'
): Promise<WebSearchResult[]> {
  // Prefer CRW, fall back to legacy Tavily
  const useCrw = !!config.CRW_API_KEY;

  if (useCrw) {
    try {
      return await webSearchCrw(query, maxResults, searchDepth);
    } catch (err) {
      // If Tavily is available, fall back gracefully on CRW failure
      if (config.TAVILY_API_KEY) {
        console.warn('[WEB-SEARCH] CRW failed, falling back to Tavily:', err);
      } else {
        throw err;
      }
    }
  }

  // Legacy Tavily path (also serves as fallback when CRW fails)
  if (!config.TAVILY_API_KEY) {
    throw new Error('CRW_API_KEY or TAVILY_API_KEY not configured');
  }

  const response = await fetch(`${config.TAVILY_API_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.TAVILY_API_KEY,
      query,
      search_depth: searchDepth,
      max_results: Math.min(maxResults, 10),
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Tavily API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as { results: Array<{ title: string; url: string; content: string; published_date?: string }> };

  const results: WebSearchResult[] = data.results.map((item) => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.content || '',
    published_date: item.published_date || null,
  }));

  console.log(`[KORTIX] Web search for '${query}' returned ${results.length} results`);
  return results;
}

async function webSearchCrw(
  query: string,
  maxResults: number,
  searchDepth: 'basic' | 'advanced',
): Promise<WebSearchResult[]> {
  const apiUrl = config.CRW_API_URL.replace(/\/+$/, '');
  const apiKey = config.CRW_API_KEY;

  const body: Record<string, unknown> = {
    query,
    limit: Math.min(maxResults, 20),
    sources: ['web'],
  };

  if (searchDepth === 'advanced') {
    body.scrapeOptions = { formats: ['markdown'], onlyMainContent: true };
  }

  const response = await fetch(`${apiUrl}/v1/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`CRW API error: ${response.status} - ${error}`);
  }

  const json = await response.json() as CrwSearchResponse;
  if (!json.success) {
    throw new Error(`CRW search failed: ${json.error ?? 'unknown error'}`);
  }

  // Handle flat array vs grouped response
  let crwResults: CrwSearchResult[];
  if (Array.isArray(json.data)) {
    crwResults = json.data;
  } else {
    crwResults = json.data.web ?? [];
  }

  const results: WebSearchResult[] = crwResults.map((item) => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || '',
    published_date: item.publishedDate || null,
  }));

  console.log(`[KORTIX] CRW web search for '${query}' returned ${results.length} results`);
  return results;
}
