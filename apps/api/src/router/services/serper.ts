import { config } from '../../config';
import type { ImageSearchResult } from '../../types';

interface CrwImageResult {
  url: string;
  title?: string;
  imageUrl: string;
  thumbnailUrl?: string;
  imageFormat?: string;
  resolution?: string;
}

interface CrwSearchResponse {
  success: boolean;
  data: { images?: CrwImageResult[] } | CrwImageResult[];
  error?: string;
}

function parseResolution(res?: string): { width: number | null; height: number | null } {
  if (!res) return { width: null, height: null };
  const match = res.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return { width: null, height: null };
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

/**
 * Search for images using CRW API (with Serper fallback).
 *
 * @param query - Search query
 * @param maxResults - Maximum number of results (1-20)
 * @param _safeSearch - Safe search filtering (not supported by CRW, kept for compat)
 * @returns List of ImageSearchResult
 */
export async function imageSearchSerper(
  query: string,
  maxResults: number = 5,
  _safeSearch: boolean = true
): Promise<ImageSearchResult[]> {
  // Prefer CRW, fall back to legacy Serper
  const useCrw = !!config.CRW_API_KEY;

  if (useCrw) {
    // CRW does not natively support safe_search filtering, but its SearXNG
    // backend returns generally-safe results by default. When the caller
    // explicitly requests unfiltered results (safe_search=false) and Serper
    // is available, route to Serper which supports safe=off natively.
    if (!_safeSearch && config.SERPER_API_KEY) {
      // Caller explicitly wants unfiltered results — route to Serper which supports safe=off
      console.log('[IMAGE-SEARCH] safe_search=false requested; using Serper (CRW does not support explicit safe_search toggling)');
    } else if (!_safeSearch && !config.SERPER_API_KEY) {
      // Caller wants unfiltered results but only CRW is available — use CRW with a warning
      console.warn('[IMAGE-SEARCH] safe_search=false requested but only CRW is configured (no Serper fallback); results may still be filtered');
      return await imageSearchCrw(query, maxResults);
    } else {
      try {
        return await imageSearchCrw(query, maxResults);
      } catch (err) {
        // If Serper is available, fall back gracefully on CRW failure
        if (config.SERPER_API_KEY) {
          console.warn('[IMAGE-SEARCH] CRW failed, falling back to Serper:', err);
        } else {
          throw err;
        }
      }
    }
  }

  // Legacy Serper path (also serves as fallback when CRW fails)
  if (!config.SERPER_API_KEY) {
    throw new Error('CRW_API_KEY or SERPER_API_KEY not configured');
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
      safe: _safeSearch ? 'active' : 'off',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Serper API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as { images: Array<{ title: string; imageUrl: string; thumbnailUrl?: string; link: string; imageWidth?: number; imageHeight?: number }> };

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

async function imageSearchCrw(
  query: string,
  maxResults: number,
): Promise<ImageSearchResult[]> {
  const apiUrl = config.CRW_API_URL.replace(/\/+$/, '');
  const apiKey = config.CRW_API_KEY;

  const response = await fetch(`${apiUrl}/v1/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit: Math.min(maxResults, 20),
      sources: ['images'],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`CRW API error: ${response.status} - ${error}`);
  }

  const json = await response.json() as CrwSearchResponse;
  if (!json.success) {
    throw new Error(`CRW image search failed: ${json.error ?? 'unknown error'}`);
  }

  // Handle grouped response vs flat array
  let rawImages: CrwImageResult[];
  if (Array.isArray(json.data)) {
    rawImages = json.data;
  } else {
    rawImages = json.data.images ?? [];
  }

  const results: ImageSearchResult[] = rawImages.map((item) => {
    const { width, height } = parseResolution(item.resolution);
    return {
      title: item.title || '',
      url: item.imageUrl || item.url || '',
      thumbnail_url: item.thumbnailUrl || item.imageUrl || '',
      source_url: item.url || '',
      width,
      height,
    };
  });

  console.log(`[KORTIX] CRW image search for '${query}' returned ${results.length} results`);
  return results;
}
