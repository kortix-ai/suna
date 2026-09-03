/**
 * `/v1/public/subprojects` — the ANONYMOUS subproject catalogue.
 *
 * Backs `apps/web/src/app/(public)/marketplace` and `/marketplace/[slug]`: a
 * logged-out visitor arriving from search should see what a subproject is and
 * what it installs, then sign up to install it. That makes this an SEO
 * acquisition surface, and the reason it is a separate app rather than two more
 * routes on `subprojectsApp`: that app mounts `combinedAuth` on `/*`, so every
 * path under it answers 401 without a token. Public routes live under
 * `/v1/public/...` with no auth middleware at all — the same split
 * `publicSessionSharesApp` uses.
 *
 * What it shows and what it deliberately does not:
 *
 *  - ONLY `visibility = 'public'` + `status = 'active'` rows. The narrowing is in
 *    the store's WHERE clause (`listSubprojects` with no `accountId`,
 *    `getPublicSubprojectBySlug`), not in this file, because a route that forgot
 *    the check would publish somebody's private subproject. Public rows are not
 *    writable over HTTP by design — they arrive by migration or direct insert
 *    (see `packages/db/migrations/*_seed_public_subprojects.sql`).
 *  - NO installed state. There is no project and no account in the request, so
 *    the public card cannot and must not say "Installed" — that is the one
 *    behavioural difference from `/projects/:id/customize/marketplace`.
 *
 * Cached with a short `max-age` + ETag, following the `/v1/system/maintenance`
 * precedent. The normal caller is Next.js ISR revalidating once an hour per
 * origin, so the cache mostly serves crawlers and repeat polls; `public` is safe
 * because the response is identical for every caller by construction.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../openapi';
import { getPublicSubprojectBySlug, listSubprojects } from '../projects/subproject-store';
import { computeEtag, etagMatches } from '../shared/http-cache';
import { createPublicSubprojectsRateLimitMiddleware } from '../shared/rate-limit';

export const publicSubprojectsApp = makeOpenApiApp();

publicSubprojectsApp.use('/*', createPublicSubprojectsRateLimitMiddleware());

/** Page size. Same bounds as the authenticated catalogue route. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function clampOffset(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 5 minutes, not the maintenance route's 5 seconds: the catalogue changes when a
 * migration ships, not when a user clicks. Still `must-revalidate` rather than
 * `stale-while-revalidate`, so a yanked subproject stops being served as soon as
 * one revalidation happens.
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

publicSubprojectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['public-subprojects'],
    summary: 'GET /public/subprojects — the anonymous public subproject catalogue',
    request: {
      query: z.object({
        q: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.any(), 'Public subprojects, most-installed first'),
      ...errors(429),
    },
  }),
  async (c: any) => {
    const limit = clampLimit(c.req.query('limit'));
    const offset = clampOffset(c.req.query('offset'));
    // No accountId and no userId: the store narrows to public + active. Passing
    // either here would widen the anonymous catalogue to somebody's account.
    const { items, total } = await listSubprojects({
      q: c.req.query('q') ?? null,
      limit,
      offset,
    });
    return cached(c, { subprojects: items, total, limit, offset });
  },
);

publicSubprojectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{slug}',
    tags: ['public-subprojects'],
    summary: 'GET /public/subprojects/:slug — one public subproject',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: json(z.any(), 'The public subproject'),
      ...errors(404, 429),
    },
  }),
  async (c: any) => {
    const subproject = await getPublicSubprojectBySlug(c.req.param('slug'));
    // 404, never 403: to an anonymous visitor a private subproject and a
    // nonexistent one are the same thing, and saying "exists but not for you"
    // would turn this route into an existence oracle for every account's
    // catalogue.
    if (!subproject) return c.json({ error: 'Subproject not found' }, 404);
    return cached(c, { subproject });
  },
);
