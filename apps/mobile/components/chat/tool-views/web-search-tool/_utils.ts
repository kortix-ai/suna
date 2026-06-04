import type { ToolCallData, ToolResultData } from '../types';
import type { LucideIcon } from 'lucide-react-native';
import { Globe, FileText, BookOpen, Calendar } from 'lucide-react-native';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchData {
  query: string | null;
  results: WebSearchResult[];
  images: string[];
  success: boolean;
  isBatch?: boolean;
  batchResults?: Array<{
    query: string;
    success: boolean;
    results: WebSearchResult[];
    answer: string;
    images: string[];
  }>;
}

const parseContent = (content: any): any => {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch (e) {
      return content;
    }
  }
  return content;
};

/** Normalize image entries to plain URL strings. API may return strings or objects with url/src. */
const normalizeImages = (images: any[]): string[] => {
  if (!Array.isArray(images)) return [];
  return images
    .map((img: any) => {
      if (typeof img === 'string') return img;
      if (typeof img === 'object' && img !== null) {
        return img.url || img.src || img.image_url || img.thumbnail || null;
      }
      return null;
    })
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
};

export function extractWebSearchData(
  toolCall: ToolCallData,
  toolResult?: ToolResultData,
  isSuccess: boolean = true
): WebSearchData {
  // Parse arguments
  let args: Record<string, any> = {};
  if (toolCall.arguments) {
    if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
      args = toolCall.arguments;
    } else if (typeof toolCall.arguments === 'string') {
      try {
        args = JSON.parse(toolCall.arguments);
      } catch {
        args = {};
      }
    }
  }

  let query = args?.query || null;
  let results: WebSearchResult[] = [];
  let images: string[] = [];

  if (toolResult?.output) {
    const output = typeof toolResult.output === 'string'
      ? parseContent(toolResult.output)
      : toolResult.output;

    // Check if this is a batch search response
    if (output.batch_mode === true && Array.isArray(output.results)) {
      // Batch search response
      const batchResults = output.results.map((batchItem: any) => ({
        query: batchItem.query || '',
        success: batchItem.success !== false,
        results: (batchItem.results || []).map((r: any) => ({
          title: r.title || '',
          url: r.url || '',
          snippet: r.content || r.snippet || ''
        })),
        answer: batchItem.answer || '',
        images: normalizeImages(batchItem.images || [])
      }));

      // Flatten all results and images for combined display
      const allResults = batchResults.flatMap(br => br.results);
      const allImages = batchResults.flatMap(br => br.images);
      const allQueries = batchResults.map(br => br.query).filter(Boolean);
      const combinedQuery = allQueries.length > 1
        ? `${allQueries.length} queries`
        : allQueries[0] || null;
      const allSuccessful = batchResults.every(br => br.success);

      return {
        query: combinedQuery,
        results: allResults,
        images: allImages,
        success: allSuccessful,
        isBatch: true,
        batchResults
      };
    }

    // Handle legacy batch_results format (for image search)
    if (output.batch_results && Array.isArray(output.batch_results)) {
      images = output.batch_results.reduce((acc: string[], res: any) => {
        return acc.concat(normalizeImages(res.images || []));
      }, [] as string[]);

      const queries = output.batch_results.map((r: any) => r.query).filter(Boolean);
      if (queries.length > 0) {
        query = queries.length > 1 ? `${queries.length} queries` : queries[0];
      }
    } else {
      images = normalizeImages(output.images || []);
    }

    if (output.results && Array.isArray(output.results)) {
      results = output.results.map((r: any) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.content || r.snippet || ''
      }));
    }
  }

  return {
    query,
    results,
    images,
    success: toolResult?.success ?? isSuccess,
    isBatch: false
  };
}

export function cleanUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function extractQueriesFromToolCall(toolCall: ToolCallData): string[] {
  if (!toolCall?.arguments) return [];

  let args: Record<string, any> = {};
  if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null) {
    args = toolCall.arguments;
  } else if (typeof toolCall.arguments === 'string') {
    try {
      args = JSON.parse(toolCall.arguments);
    } catch {
      return [];
    }
  }

  // Check for queries array (batch mode)
  if (args?.queries && Array.isArray(args.queries)) {
    return args.queries.filter((q: any) => typeof q === 'string' && q.trim().length > 0);
  }

  // Check for single query that might be an array
  if (args?.query) {
    // If query is already an array
    if (Array.isArray(args.query)) {
      return args.query.filter((q: any) => typeof q === 'string' && q.trim().length > 0);
    }
    // If query is a string that looks like a JSON array
    if (typeof args.query === 'string') {
      const trimmed = args.query.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            return parsed.filter((q: any) => typeof q === 'string' && q.trim().length > 0);
          }
        } catch {
          // Not valid JSON, treat as single query
        }
      }
      return [args.query];
    }
  }

  return [];
}

/**
 * Gets the favicon URL for a given URL using Google's favicon service.
 * Always returns a valid URL string (never null).
 * If URL parsing fails, returns a default favicon URL.
 */
export function getFavicon(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  } catch (e) {
    // Return a default favicon URL if URL parsing fails
    return `https://www.google.com/s2/favicons?domain=example.com&sz=128`;
  }
}

/**
 * Determines the result type (Website, Article, Wiki, Blog) based on URL and title.
 * Returns an object with the icon component and label string.
 */
export function getResultType(result: { url?: string; title?: string }): { icon: LucideIcon; label: string } {
  const { url, title } = result;

  // Guard against undefined/null values
  if (!url || !title) {
    return { icon: Globe, label: 'Website' };
  }

  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();

  if (urlLower.includes('news') || urlLower.includes('article') || titleLower.includes('news')) {
    return { icon: FileText, label: 'Article' };
  } else if (urlLower.includes('wiki')) {
    return { icon: BookOpen, label: 'Wiki' };
  } else if (urlLower.includes('blog')) {
    return { icon: Calendar, label: 'Blog' };
  } else {
    return { icon: Globe, label: 'Website' };
  }
}

