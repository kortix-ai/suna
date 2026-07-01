import { Effect, Schedule, Schema } from 'effect';
import type { ImageSearchResult } from '../../types';
import { getTraceHeaders } from '../../lib/request-context';
import { AppConfig, HttpClient } from '../../effect/services';
import { runEffectOrThrow } from '../../effect/http';

const SerperImageSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  imageUrl: Schema.optional(Schema.String),
  thumbnailUrl: Schema.optional(Schema.String),
  link: Schema.optional(Schema.String),
  imageWidth: Schema.optional(Schema.Number),
  imageHeight: Schema.optional(Schema.Number),
});

const SerperResponseSchema = Schema.Struct({
  images: Schema.optional(Schema.Array(SerperImageSchema)),
});

class SerperSearchError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SerperSearchError';
    this.cause = cause;
  }
}

const serperRetryPolicy = Schedule.addDelay(Schedule.recurs(2), () => '100 millis');

/**
 * Search for images using Serper API (Google Images).
 *
 * @param query - Search query
 * @param maxResults - Maximum number of results (1-20)
 * @param safeSearch - Enable safe search filtering
 * @returns List of ImageSearchResult
 */
export function imageSearchSerperEffect(
  query: string,
  maxResults: number = 5,
  safeSearch: boolean = true
): Effect.Effect<ImageSearchResult[], SerperSearchError, AppConfig | HttpClient> {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const http = yield* HttpClient;

    if (!config.SERPER_API_KEY) {
      return yield* Effect.fail(new SerperSearchError('SERPER_API_KEY not configured'));
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        http.fetch(`${config.SERPER_API_URL}/images`, {
          method: 'POST',
          headers: {
            'X-API-KEY': config.SERPER_API_KEY,
            'Content-Type': 'application/json',
            ...getTraceHeaders(),
          },
          body: JSON.stringify({
            q: query,
            num: Math.min(maxResults, 20),
            safe: safeSearch ? 'active' : 'off',
          }),
        }),
      catch: (cause) => new SerperSearchError(`Serper request failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause),
    }).pipe(Effect.retry(serperRetryPolicy));

    if (!response.ok) {
      const error = yield* Effect.tryPromise({
        try: () => response.text(),
      catch: (cause) => new SerperSearchError(`Serper API error: ${response.status}`, cause),
      });
      return yield* Effect.fail(
        new SerperSearchError(`Serper API error: ${response.status} - ${error}`),
      );
    }

    const json = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new SerperSearchError('Serper response was not valid JSON', cause),
    });

    const data = yield* Schema.decodeUnknown(SerperResponseSchema)(json).pipe(
      Effect.mapError(
        (cause) => new SerperSearchError(`Serper response schema mismatch: ${cause.message}`, cause),
      ),
    );

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
  });
}

export async function imageSearchSerper(
  query: string,
  maxResults: number = 5,
  safeSearch: boolean = true
): Promise<ImageSearchResult[]> {
  return runEffectOrThrow(imageSearchSerperEffect(query, maxResults, safeSearch));
}
