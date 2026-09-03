import 'server-only';

import {
  PublicSubprojectError,
  getPublicSubproject,
  listPublicSubprojects,
  type Subproject,
} from '@kortix/sdk';
import { runWithKortix } from '@kortix/sdk/server';

import { getServerPublicEnv } from '@/lib/public-env-server';

/**
 * Server-side reads of the PUBLIC subproject catalogue, for `/marketplace`.
 *
 * Two things are load-bearing here.
 *
 * 1. `runWithKortix`, not `configureKortix`. `configureKortix` runs in a CLIENT
 *    provider, so a server render has no platform config and `getBackendUrl()`
 *    would fall back to `http://localhost:8008/v1` — correct on a laptop, wrong
 *    everywhere else. `runWithKortix` binds `backendUrl` for this call's async
 *    continuation only, which is also what keeps two concurrent renders from
 *    racing on a process-global.
 * 2. `getToken` returns null. These routes are `/v1/public/subprojects/*` and
 *    take no auth at all. A logged-in visitor's token must not leak into an
 *    ISR-cached render — the page is the same bytes for everyone, which is the
 *    entire point of `revalidate`.
 *
 * Nothing here reads installed state. The public catalogue does not know which
 * project a visitor has, and must not imply one.
 */
function scoped<T>(read: () => Promise<T>): Promise<T> {
  const backendUrl = getServerPublicEnv().BACKEND_URL;
  if (!backendUrl) throw new Error('BACKEND_URL is not configured');
  return runWithKortix({ backendUrl, getToken: async () => null }, read);
}

/** How many cards the index renders. The whole curated catalogue fits in one page. */
const INDEX_LIMIT = 100;

/**
 * The catalogue for the index grid.
 *
 * Deliberately NOT wrapped in a try/catch: a failed read must fail the render so
 * Next serves the last good ISR page (or a 5xx a crawler retries) instead of
 * caching an empty catalogue for a full hour.
 */
export async function loadPublicSubprojects(): Promise<Subproject[]> {
  const listing = await scoped(() => listPublicSubprojects({ limit: INDEX_LIMIT }));
  return listing.subprojects;
}

/** One subproject by slug, or null when the API answers 404. */
export async function loadPublicSubproject(slug: string): Promise<Subproject | null> {
  try {
    return await scoped(() => getPublicSubproject(slug));
  } catch (error) {
    // 404 is the normal outcome for a bad or private slug — the route renders
    // `notFound()`. Anything else is a real failure and must reach Next.
    if (error instanceof PublicSubprojectError && error.status === 404) return null;
    throw error;
  }
}
