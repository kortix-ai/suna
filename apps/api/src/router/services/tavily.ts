import { Effect, Schema } from 'effect';
import { config } from '../../config';
import type { WebSearchResult } from '../../types';
import { getTraceHeaders } from '../../lib/request-context';

const TavilyResultSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  published_date: Schema.optional(Schema.String),
});

const TavilyResponseSchema = Schema.Struct({
  results: Schema.Array(TavilyResultSchema),
});

class TavilySearchError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TavilySearchError';
    this.cause = cause;
  }
}

/**
 * Search the web using Tavily API.
 *
 * @param query - Search query
 * @param maxResults - Maximum number of results (1-10)
 * @param searchDepth - "basic" or "advanced"
 * @returns List of WebSearchResult
 */
export function webSearchTavilyEffect(
  query: string,
  maxResults: number = 5,
  searchDepth: 'basic' | 'advanced' = 'basic'
): Effect.Effect<WebSearchResult[], TavilySearchError> {
  if (!config.TAVILY_API_KEY) {
    return Effect.fail(new TavilySearchError('TAVILY_API_KEY not configured'));
  }

  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${config.TAVILY_API_URL}/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getTraceHeaders(),
          },
          body: JSON.stringify({
            api_key: config.TAVILY_API_KEY,
            query,
            search_depth: searchDepth,
            max_results: Math.min(maxResults, 10),
            include_answer: false,
            include_raw_content: false,
          }),
        }),
      catch: (cause) => new TavilySearchError(`Tavily request failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
    });

    if (!response.ok) {
      const error = yield* Effect.tryPromise({
        try: () => response.text(),
      catch: (cause) => new TavilySearchError(`Tavily API error: ${response.status}`, cause),
      });
      return yield* Effect.fail(
        new TavilySearchError(`Tavily API error: ${response.status} - ${error}`),
      );
    }

    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new TavilySearchError('Tavily response was not valid JSON', cause),
    });

    const data = yield* Schema.decodeUnknown(TavilyResponseSchema)(json).pipe(
      Effect.mapError(
        (cause) => new TavilySearchError(`Tavily response schema mismatch: ${cause.message}`, cause),
      ),
    );

    const results: WebSearchResult[] = data.results.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
      published_date: item.published_date || null,
    }));

    console.log(`[KORTIX] Web search for '${query}' returned ${results.length} results`);

    return results;
  });
}

export async function webSearchTavily(
  query: string,
  maxResults: number = 5,
  searchDepth: 'basic' | 'advanced' = 'basic'
): Promise<WebSearchResult[]> {
  return Effect.runPromise(webSearchTavilyEffect(query, maxResults, searchDepth));
}
