import { config } from '../config';
import type { WebSearchResult } from '../types';

interface TavilyResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
    published_date?: string;
  }>;
}

/**
 * Search the web using Tavily API.
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
  if (!config.TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY not configured');
  }

  const response = await fetch(`${config.TAVILY_API_URL}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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

  const data: TavilyResponse = await response.json();

  const results: WebSearchResult[] = data.results.map((item) => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.content || '',
    published_date: item.published_date || null,
  }));

  console.log(`[KORTIX] Web search for '${query}' returned ${results.length} results`);

  return results;
}
