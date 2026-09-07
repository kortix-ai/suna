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
import {
  findTemplateCatalogEntry,
  getTemplateBySlug,
  listTemplateCatalog,
} from '../templates/catalog';
import { defaultTemplateFile, listTemplateFiles, readTemplateFile } from './files';
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

/**
 * The template's own repository, read at its pinned commit.
 *
 * These two are the only routes here that leave the process — everything above
 * is served from the static catalog. They exist because a template IS a repo:
 * what it declares is in the catalog, but what it actually SAYS is in its
 * README and its agent and skill files, and a person choosing a template wants
 * to read that before installing it. See `./files` for the pinning, the memo
 * and the guards.
 */
publicTemplatesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{slug}/files',
    tags: ['public-templates'],
    summary: 'GET /public/templates/:slug/files — the template repo file tree',
    request: { params: z.object({ slug: z.string() }) },
    responses: {
      200: json(z.any(), 'Every readable file at the pinned commit'),
      ...errors(404, 429),
    },
  }),
  async (c: any) => {
    const template = findTemplateCatalogEntry(c.req.param('slug'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    const files = await listTemplateFiles(template);
    return cached(c, { files, default_path: defaultTemplateFile(files) ?? null });
  },
);

publicTemplatesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{slug}/file',
    tags: ['public-templates'],
    summary: 'GET /public/templates/:slug/file?path= — one file, as text',
    request: {
      params: z.object({ slug: z.string() }),
      query: z.object({ path: z.string() }),
    },
    responses: {
      200: json(z.any(), "The file's text"),
      ...errors(400, 404, 429),
    },
  }),
  async (c: any) => {
    const template = findTemplateCatalogEntry(c.req.param('slug'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    const path = (c.req.query('path') ?? '').trim();
    if (!path) return c.json({ error: 'path is required' }, 400);
    const content = await readTemplateFile(template, path);
    // 404, not 403: a path this template does not publish and a path that does
    // not exist are the same answer, so the route cannot be used to probe.
    if (content == null) return c.json({ error: 'File not found' }, 404);
    return cached(c, { path, content });
  },
);
