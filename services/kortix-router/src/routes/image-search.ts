import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ImageSearchRequestSchema } from '../types';
import type { ImageSearchResponse, AppContext } from '../types';
import { imageSearchSerper } from '../services/serper';
import { checkCredits, deductToolCredits } from '../services/billing';

const imageSearch = new Hono<{ Variables: AppContext }>();

/**
 * POST /image-search
 *
 * Search for images using Serper API (Google Images).
 * Requires authentication via KORTIX_TOKEN.
 * Credits are deducted per search.
 */
imageSearch.post('/', async (c) => {
  const accountId = c.get('accountId');

  // Validate request body
  const body = await c.req.json();
  const parseResult = ImageSearchRequestSchema.safeParse(body);

  if (!parseResult.success) {
    throw new HTTPException(400, {
      message: `Validation error: ${parseResult.error.message}`,
    });
  }

  const request = parseResult.data;

  // Check credits before operation
  const creditCheck = await checkCredits(accountId);
  if (!creditCheck.hasCredits) {
    throw new HTTPException(402, { message: creditCheck.message });
  }

  try {
    // Perform search
    const results = await imageSearchSerper(
      request.query,
      request.max_results,
      request.safe_search
    );

    // Deduct credits after successful search
    const billingResult = await deductToolCredits(
      accountId,
      'image_search',
      results.length,
      `Image search: ${request.query.slice(0, 50)}`,
      request.session_id
    );

    if (!billingResult.success && !billingResult.skipped) {
      console.warn(
        `[KORTIX] Billing failed for ${accountId} but returning results anyway`
      );
    }

    const response: ImageSearchResponse = {
      results,
      query: request.query,
      cost: billingResult.cost,
    };

    return c.json(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes('not configured')) {
      console.error(`[KORTIX] Image search config error: ${error.message}`);
      throw new HTTPException(500, { message: error.message });
    }

    console.error(`[KORTIX] Image search error: ${error}`);
    throw new HTTPException(500, {
      message: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

export { imageSearch };
