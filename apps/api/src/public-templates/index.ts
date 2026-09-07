/**
 * `/v1/public/templates` — the ANONYMOUS templates catalog.
 *
 * Backs `apps/web/src/app/(public)/(seo)/templates` and `/templates/[slug]`
 * (a logged-out visitor arriving from search sees what a template installs,
 * then signs up to install it), the in-project Templates tab, and
 * `kortix templates`. Public routes live under `/v1/public/...` with no auth
 * middleware at all — the same split `publicSessionSharesApp` uses.
 *
 * The catalog is a static list (`../templates/catalog.ts`), so there is
 * nothing to narrow by caller and no installed state to report: the response is
 * identical for everyone by construction, which is what makes `public` caching
 * safe. Installing is project-scoped — `POST /projects/:id/templates/install-session`.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { getTemplateBySlug, listTemplateCatalog } from '../templates/catalog';
import { errors, json, makeOpenApiApp } from '../openapi';
import { computeEtag, etagMatches } from '../shared/http-cache';
import { createPublicTemplatesRateLimitMiddleware } from '../shared/rate-limit';

export const publicTemplatesApp = makeOpenApiApp();

publicTemplatesApp.use('/*', createPublicTemplatesRateLimitMiddleware());

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

publicTemplatesApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['public-templates'],
    summary: 'GET /public/templates — the template catalog',
    request: { query: z.object({ q: z.string().optional() }) },
    responses: {
      200: json(z.any(), 'Every template, optionally narrowed by `q`'),
      ...errors(429),
    },
  }),
  async (c: any) => cached(c, { templates: listTemplateCatalog(c.req.query('q') ?? null) }),
);

publicTemplatesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{slug}',
    tags: ['public-templates'],
    summary: 'GET /public/templates/:slug — one template',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: json(z.any(), 'The template'),
      ...errors(404, 429),
    },
  }),
  async (c: any) => {
    const template = getTemplateBySlug(c.req.param('slug'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return cached(c, { template });
  },
);
