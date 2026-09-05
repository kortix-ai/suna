import 'server-only';

import {
  MarketplaceError,
  type MarketplaceTemplate,
  getMarketplaceTemplate,
  listMarketplaceTemplates,
} from '@kortix/sdk';
import { runWithKortix } from '@kortix/sdk/server';

import { getServerPublicEnv } from '@/lib/public-env-server';

/**
 * Server-side reads of the PUBLIC template catalog, for `/marketplace`.
 *
 * Two things are load-bearing here.
 *
 * 1. `runWithKortix`, not `configureKortix`. `configureKortix` runs in a CLIENT
 *    provider, so a server render has no platform config and `getBackendUrl()`
 *    would fall back to `http://localhost:8008/v1` — correct on a laptop, wrong
 *    everywhere else. `runWithKortix` binds `backendUrl` for this call's async
 *    continuation only, which is also what keeps two concurrent renders from
 *    racing on a process-global.
 * 2. `getToken` returns null. These routes are `/v1/public/marketplace/*` and
 *    take no auth at all. A logged-in visitor's token must not leak into an
 *    ISR-cached render — the page is the same bytes for everyone, which is the
 *    entire point of `revalidate`.
 */
function scoped<T>(read: () => Promise<T>): Promise<T> {
  const backendUrl = getServerPublicEnv().BACKEND_URL;
  if (!backendUrl) throw new Error('BACKEND_URL is not configured');
  return runWithKortix({ backendUrl, getToken: async () => null }, read);
}

/**
 * The catalog for the index grid.
 *
 * Deliberately NOT wrapped in a try/catch: a failed read must fail the render so
 * Next serves the last good ISR page (or a 5xx a crawler retries) instead of
 * caching an empty catalog for a full hour.
 */
export async function loadPublicTemplates(): Promise<MarketplaceTemplate[]> {
  const listing = await scoped(() => listMarketplaceTemplates());
  return listing.templates;
}

/** One template by slug, or null when the API answers 404. */
export async function loadPublicTemplate(slug: string): Promise<MarketplaceTemplate | null> {
  try {
    return await scoped(() => getMarketplaceTemplate(slug));
  } catch (error) {
    // 404 is the normal outcome for an unknown slug — the route renders
    // `notFound()`. Anything else is a real failure and must reach Next.
    if (error instanceof MarketplaceError && error.status === 404) return null;
    throw error;
  }
}
