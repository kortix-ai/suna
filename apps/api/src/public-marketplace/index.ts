/**
 * `/v1/public/marketplace/templates` — the ANONYMOUS marketplace catalog.
 *
 * Backs `apps/web/src/app/(public)/(seo)/marketplace` and `/marketplace/[slug]`
 * (a logged-out visitor arriving from search sees what a template installs,
 * then signs up to install it), the in-project Marketplace tab, and
 * `kortix marketplace`. Public routes live under `/v1/public/...` with no auth
 * middleware at all — the same split `publicSessionSharesApp` uses.
 *
 * The catalog is a static list (`../marketplace/templates.ts`), so there is
 * nothing to narrow by caller and no installed state to report: the response is
 * identical for everyone by construction, which is what makes `public` caching
 * safe. Installing is project-scoped — `POST /projects/:id/marketplace/install-session`.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { getMarketplaceTemplate, listMarketplaceTemplates } from '../marketplace/templates';
import { errors, json, makeOpenApiApp } from '../openapi';
import { computeEtag, etagMatches } from '../shared/http-cache';
import { createPublicMarketplaceRateLimitMiddleware } from '../shared/rate-limit';

export const publicMarketplaceApp = makeOpenApiApp();

publicMarketplaceApp.use('/*', createPublicMarketplaceRateLimitMiddleware());

/**
 * 5 minutes: the catalog changes when a deploy ships, not when a user clicks.
 * `must-revalidate` rather than `stale-while-revalidate`, so a withdrawn
 * template stops being served as soon as one revalidation happens.
 */
const CACHE_CONTROL = 'public, max-age=300, must-revalidate';

/** Serve `payload` with the cache headers, or 304 when the caller's ETag matches. */
function cached(c: any, payload: unknown) {
  const etag = computeEtag(payload);
  c.header('Cache-Control', CACHE_CONTROL);
  c.header('ETag', etag);
  if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
  return c.json(payload);
}

publicMarketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/templates',
    tags: ['public-marketplace'],
    summary: 'GET /public/marketplace/templates — the template catalog',
    request: { query: z.object({ q: z.string().optional() }) },
    responses: {
      200: json(z.any(), 'Every template, optionally narrowed by `q`'),
      ...errors(429),
    },
  }),
  async (c: any) => cached(c, { templates: listMarketplaceTemplates(c.req.query('q') ?? null) }),
);

publicMarketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/templates/{slug}',
    tags: ['public-marketplace'],
    summary: 'GET /public/marketplace/templates/:slug — one template',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: json(z.any(), 'The template'),
      ...errors(404, 429),
    },
  }),
  async (c: any) => {
    const template = getMarketplaceTemplate(c.req.param('slug'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return cached(c, { template });
  },
);
