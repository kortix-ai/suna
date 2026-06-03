import { createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { WebSearchRequestSchema } from '../../types';
import type { WebSearchResponse, AppContext } from '../../types';
import { webSearchTavily } from '../services/tavily';
import { checkCredits, deductToolCredits } from '../services/billing';
import { makeOpenApiApp, json, errors, auth } from '../../openapi';

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
      body: { content: { 'application/json': { schema: WebSearchRequestSchema } } },
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
    const toolName = `web_search_${request.search_depth}`;

    // Check credits before operation
    const creditCheck = await checkCredits(accountId);
    if (!creditCheck.hasCredits) {
      throw new HTTPException(402, { message: creditCheck.message });
    }

    try {
      // Perform search
      const results = await webSearchTavily(
        request.query,
        request.max_results,
        request.search_depth
      );

      // Deduct credits after successful search
      const billingResult = await deductToolCredits(
        accountId,
        toolName,
        results.length,
        `Web search: ${request.query.slice(0, 50)}`,
        request.session_id
      );

      if (!billingResult.success && !billingResult.skipped) {
        console.warn(
          `[KORTIX] Billing failed for ${accountId} but returning results anyway`
        );
      }

      const response: WebSearchResponse = {
        results,
        query: request.query,
        cost: billingResult.cost,
      };

      return c.json(response);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not configured')) {
        console.error(`[KORTIX] Web search config error: ${error.message}`);
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
