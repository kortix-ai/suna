import 'server-only';

import {
  TemplateError,
  type Template,
  type TemplateFileListing,
  getTemplateBySlug,
  listTemplateCatalog,
  listTemplateFiles,
  readTemplateFile,
} from '@kortix/sdk';
import { runWithKortix } from '@kortix/sdk/server';

import { getServerPublicEnv } from '@/lib/public-env-server';

/**
 * Server-side reads of the PUBLIC template catalog, for `/templates`.
 *
 * Two things are load-bearing here.
 *
 * 1. `runWithKortix`, not `configureKortix`. `configureKortix` runs in a CLIENT
 *    provider, so a server render has no platform config and `getBackendUrl()`
 *    would fall back to `http://localhost:8008/v1` — correct on a laptop, wrong
 *    everywhere else. `runWithKortix` binds `backendUrl` for this call's async
 *    continuation only, which is also what keeps two concurrent renders from
 *    racing on a process-global.
 * 2. `getToken` returns null. These routes are `/v1/public/templates/*` and
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
export async function loadPublicTemplates(): Promise<Template[]> {
  const listing = await scoped(() => listTemplateCatalog());
  return listing.templates;
}

/**
 * The template repository's file tree.
 *
 * Degrades to an empty listing on ANY failure, unlike the catalog reads above.
 * The tree is an enrichment: the page's real content is what the template
 * declares, which is already in hand, so an unreachable repo or a GitHub rate
 * limit must cost the reader a file browser — not the page.
 */
export async function loadPublicTemplateFiles(slug: string): Promise<TemplateFileListing> {
  try {
    return await scoped(() => listTemplateFiles(slug));
  } catch {
    return { files: [], default_path: null };
  }
}

/**
 * One file's text, server-side, for the document the page opens on.
 *
 * Same rule as the listing: a file that will not load is a missing panel, never
 * a failed render.
 */
export async function loadPublicTemplateFile(
  slug: string,
  path: string | null,
): Promise<string | null> {
  if (!path) return null;
  try {
    return await scoped(() => readTemplateFile(slug, path));
  } catch {
    return null;
  }
}

/** One template by slug, or null when the API answers 404. */
export async function loadPublicTemplate(slug: string): Promise<Template | null> {
  try {
    return await scoped(() => getTemplateBySlug(slug));
  } catch (error) {
    // 404 is the normal outcome for an unknown slug — the route renders
    // `notFound()`. Anything else is a real failure and must reach Next.
    if (error instanceof TemplateError && error.status === 404) return null;
    throw error;
  }
}
