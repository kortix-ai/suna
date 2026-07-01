import type { Effect } from 'effect';
import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { WebSearchRequestSchema } from '../../types';
import type { WebSearchResponse, AppContext } from '../../types';
import { makeOpenApiApp, json, errors, auth } from '../../openapi';
import {
  CreditCheckError,
  InsufficientCreditsError,
  SearchBillingError,
  SearchProviderError,
  runWebSearchWorkflow,
} from '../services/search-workflow';

const webSearch = makeOpenApiApp<{ Variables: AppContext }>();

/** Response shape mirrors WebSearchResponse — permissive on opaque result fields. */
const WebSearchResponseSchema = z
  .object({
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        published_date: z.string().nullable(),
      }),
    ),
    query: z.string(),
    cost: z.number(),
  })
  .openapi('WebSearchResponse');

/**
 * POST /web-search
 *
 * Search the web using Tavily API.
 * Requires authentication via KORTIX_TOKEN.
 * Credits are deducted based on search depth (basic or advanced).
 */
webSearch.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['router'],
    summary: 'Search the web (Tavily)',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: {
      200: json(WebSearchResponseSchema, 'Web search results'),
      ...errors(400, 401, 402, 500),
    },
  }),
  async (c) => {
    const accountId = c.get('accountId');

    // Validate request body — keep manual safeParse to preserve the existing
    // `Validation error: …` HTTPException(400) contract (not the zod-openapi hook shape).
    const body = await c.req.json();
    const parseResult = WebSearchRequestSchema.safeParse(body);

    if (!parseResult.success) {
      throw new HTTPException(400, {
        message: `Validation error: ${parseResult.error.message}`,
      });
    }

    const request = parseResult.data;
    try {
      const response: WebSearchResponse = await runWebSearchWorkflow(accountId, request);
      return c.json(response);
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        throw new HTTPException(402, { message: error.message });
      }

      if (error instanceof SearchProviderError && error.message.includes('not configured')) {
        console.error(`[KORTIX] Web search config error: ${error.message}`);
        throw new HTTPException(500, { message: error.message });
      }

      if (error instanceof CreditCheckError || error instanceof SearchBillingError) {
        console.error(`[KORTIX] Web search workflow error: ${error.message}`);
        throw new HTTPException(500, { message: error.message });
      }

      console.error(`[KORTIX] Web search error: ${error}`);
      throw new HTTPException(500, {
        message: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
);

export { webSearch };
