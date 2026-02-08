import { config } from '../config';
import type { ImageSearchResult } from '../types';

interface SerperResponse {
  images: Array<{
    title: string;
    imageUrl: string;
    thumbnailUrl?: string;
    link: string;
    imageWidth?: number;
    imageHeight?: number;
  }>;
}

/**
 * Search for images using Serper API (Google Images).
 *
 * @param query - Search query
 * @param maxResults - Maximum number of results (1-20)
 * @param safeSearch - Enable safe search filtering
 * @returns List of ImageSearchResult
 */
export async function imageSearchSerper(
  query: string,
  maxResults: number = 5,
  safeSearch: boolean = true
): Promise<ImageSearchResult[]> {
  if (!config.SERPER_API_KEY) {
    throw new Error('SERPER_API_KEY not configured');
  }

  const response = await fetch(`${config.SERPER_API_URL}/images`, {
    method: 'POST',
    headers: {
      'X-API-KEY': config.SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: Math.min(maxResults, 20),
      safe: safeSearch ? 'active' : 'off',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Serper API error: ${response.status} - ${error}`);
  }

  const data: SerperResponse = await response.json();

  const results: ImageSearchResult[] = (data.images || []).map((item) => ({
    title: item.title || '',
    url: item.imageUrl || '',
    thumbnail_url: item.thumbnailUrl || item.imageUrl || '',
    source_url: item.link || '',
    width: item.imageWidth || null,
    height: item.imageHeight || null,
  }));

  console.log(`[KORTIX] Image search for '${query}' returned ${results.length} results`);

  return results;
}
