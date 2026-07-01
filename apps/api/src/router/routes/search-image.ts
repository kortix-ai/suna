import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { ImageSearchRequestSchema } from '../../types';
import type { ImageSearchResponse, AppContext } from '../../types';
import { makeOpenApiApp, json, errors, auth } from '../../openapi';
import {
  CreditCheckError,
  InsufficientCreditsError,
  SearchBillingError,
  SearchProviderError,
  runImageSearchWorkflow,
} from '../services/search-workflow';

const imageSearch = makeOpenApiApp<{ Variables: AppContext }>();

/** Response shape mirrors ImageSearchResponse — permissive on opaque result fields. */
const ImageSearchResponseSchema = z
  .object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        thumbnail_url: z.string(),
        source_url: z.string(),
        width: z.number().nullable(),
        height: z.number().nullable(),
      }),
    ),
    query: z.string(),
    cost: z.number(),
  })
  .openapi('ImageSearchResponse');

/**
 * POST /image-search
 *
 * Search for images using Serper API (Google Images).
 * Requires authentication via KORTIX_TOKEN.
 * Credits are deducted per search.
 */
imageSearch.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['router'],
    summary: 'Search for images (Serper / Google Images)',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(ImageSearchResponseSchema, 'Image search results'),
      ...errors(400, 401, 402, 500),
    },
  }),
  async (c) => {
    const accountId = c.get('accountId');

    // Validate request body — keep manual safeParse to preserve the existing
    // `Validation error: …` HTTPException(400) contract (not the zod-openapi hook shape).
    const body = await c.req.json();
    const parseResult = ImageSearchRequestSchema.safeParse(body);

    if (!parseResult.success) {
      throw new HTTPException(400, {
        message: `Validation error: ${parseResult.error.message}`,
      });
    }

    const request = parseResult.data;

    try {
      const response: ImageSearchResponse = await runImageSearchWorkflow(accountId, request);
      return c.json(response);
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        throw new HTTPException(402, { message: error.message });
      }

      if (error instanceof SearchProviderError && error.message.includes('not configured')) {
        console.error(`[KORTIX] Image search config error: ${error.message}`);
        throw new HTTPException(500, { message: error.message });
      }

      if (error instanceof CreditCheckError || error instanceof SearchBillingError) {
        console.error(`[KORTIX] Image search workflow error: ${error.message}`);
        throw new HTTPException(500, { message: error.message });
      }

      console.error(`[KORTIX] Image search error: ${error}`);
      throw new HTTPException(500, {
        message: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
);

export { imageSearch };
