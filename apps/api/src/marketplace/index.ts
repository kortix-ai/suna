/**
 * /v1/marketplace — browse the registry catalog. Read-only routes are public; installing
 * is project-scoped and lives under /v1/projects/:id/registry/* (see r10.ts).
 */

import { createRoute, z } from '@hono/zod-openapi';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import {
  _resetExternalCache,
  assertAllowedSourceAddress,
  catalogStatus,
  clampMarketplaceItemsLimit,
  FEATURED_MARKETPLACES,
  getCatalogItemDetail,
  getCatalogItemFile,
  listCatalogItemsLive,
  listCatalogItemsPage,
  listFeaturedMarketplaces,
  listMarketplaces,
  registerMarketplaceSourceProvider,
  warmMarketplaceCatalog,
} from './catalog';
import { addSource, listSources, removeSource } from './sources-store';

// Wire DB-persisted sources into the catalog. Done here (not in catalog.ts) so
// catalog.ts stays free of the config/db import graph for pure unit tests.
registerMarketplaceSourceProvider(listSources);

// Warm the catalog in the background at boot so the first marketplace open is
// instant instead of paying for the cold GitHub scan. The cache lives on
// globalThis, so this also stays warm across `bun --hot` reloads in dev.
warmMarketplaceCatalog();

export const marketplaceApp = makeOpenApiApp<AppEnv>();

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/items',
    tags: ['marketplace'],
    summary: 'GET /marketplace/items',
    request: {
      query: z.object({
        query: z.string().optional(),
        type: z.string().optional(),
        source: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.any(), 'Catalog items'),
    },
  }),
  async (c: any) => {
    const q = c.req.query();
    // Pagination is opt-in: only a present, numeric `limit` triggers slicing —
    // absent/non-numeric `limit` must still return the full filtered list
    // (existing callers, e.g. the web's default-project-skills lookup, filter
    // client-side and rely on getting everything back). A present-but-out-of-
    // range `limit` (e.g. 0, negative, >200) still opts in, clamped to [1,200].
    // 200 (not 100) so the explore landing's `MARKETPLACE_EXPLORE_LANDING_LIMIT`
    // (120) is actually honored instead of silently truncated by this clamp.
    const parsedLimit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : NaN;
    const hasLimit = Number.isFinite(parsedLimit);
    const parsedOffset = q.offset !== undefined ? Number.parseInt(q.offset, 10) : NaN;
    const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
    if (hasLimit) {
      const limit = clampMarketplaceItemsLimit(parsedLimit);
      const { items, total } = await listCatalogItemsPage({
        query: q.query,
        type: q.type,
        source: q.source,
        limit,
        offset,
      });
      // `loading`/`pending`/`sources` let the UI stream sources in (Kortix first),
      // poll, and show a spinner per still-resolving source.
      return c.json({ items, total, hasMore: offset + items.length < total, ...catalogStatus() });
    }
    const items = await listCatalogItemsLive({ query: q.query, type: q.type, source: q.source });
    // `loading`/`pending`/`sources` let the UI stream sources in (Kortix first),
    // poll, and show a spinner per still-resolving source.
    return c.json({ items, total: items.length, hasMore: false, ...catalogStatus() });
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/marketplaces',
    tags: ['marketplace'],
    summary: 'GET /marketplace/marketplaces',
    responses: {
      200: json(z.any(), 'Distinct marketplaces with item counts'),
    },
  }),
  async (c: any) => {
    return c.json({ marketplaces: await listMarketplaces(), ...catalogStatus() });
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/marketplaces/featured',
    tags: ['marketplace'],
    summary: 'GET /marketplace/marketplaces/featured',
    responses: {
      200: json(z.any(), 'Curated featured marketplaces'),
    },
  }),
  async (c: any) => {
    return c.json({ featured: await listFeaturedMarketplaces() });
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/items/{id}',
    tags: ['marketplace'],
    summary: 'GET /marketplace/items/:id',
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Item detail'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const detail = await getCatalogItemDetail(c.req.param('id'));
    if (!detail) return c.json({ error: 'Not found' }, 404);
    return c.json(detail);
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/items/{id}/file',
    tags: ['marketplace'],
    summary: 'GET /marketplace/items/:id/file',
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ path: z.string().min(1) }),
    },
    responses: {
      200: json(z.any(), 'File content'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const file = await getCatalogItemFile(c.req.param('id'), c.req.query('path'));
    if (!file) return c.json({ error: 'Not found' }, 404);
    return c.json(file);
  },
);

// ── Sources ("Add a marketplace") ──────────────────────────────────────────

marketplaceApp.use('/sources', supabaseAuth);
marketplaceApp.use('/sources/*', supabaseAuth);
// Operator-managed registries (a GitHub repo, Git URL, or local folder) whose
// items merge into the catalog. Platform-global; persisted as a platform setting.
// Mutating this list is normally a platform-admin action (GET stays open to any
// authenticated user).
//
// Exception: the curated FEATURED_MARKETPLACES are vetted, public, read-only git
// repos (they resolve out of the box and carry no SSRF/LFI surface). Enabling one
// is "just git" — any signed-in user may flip a featured source on so they can
// explore it. Adding an ARBITRARY address stays admin-only (that's the injection
// surface `assertAllowedSourceAddress` guards). DELETE stays admin-only.
const FEATURED_SOURCE_ADDRESSES = new Set(FEATURED_MARKETPLACES.map((f) => f.address));
marketplaceApp.use('/sources/*', async (c, next) => {
  if (c.req.method === 'DELETE') return requireAdmin(c, next);
  await next();
});

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/sources',
    tags: ['marketplace'],
    summary: 'GET /marketplace/sources',
    ...auth,
    responses: {
      200: json(z.any(), 'Configured marketplace sources'),
      ...errors(401),
    },
  }),
  async (c: any) => {
    return c.json({ sources: await listSources() });
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'post',
    path: '/sources',
    tags: ['marketplace'],
    summary: 'POST /marketplace/sources',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              address: z.string().min(1),
              gitRef: z.string().optional(),
              sparsePaths: z.array(z.string()).optional(),
              label: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.any(), 'Added source'),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
    const body = await c.req.json().catch(() => ({}));
    // Adding an arbitrary source is admin-only; the curated FEATURED_MARKETPLACES
    // are vetted, public, read-only git repos (they resolve out of the box and
    // carry no SSRF/LFI surface) so any signed-in user may enable one to explore
    // it. See the module-level comment above for the full rationale.
    const address = String((body as { address?: unknown })?.address ?? '').trim();
    if (!FEATURED_SOURCE_ADDRESSES.has(address)) {
      // Throws (401/403) on failure — caught by the app's global onError and
      // turned into the right response; resolves to undefined on success.
      await requireAdmin(c, async () => {});
    }
    try {
      // LFI/SSRF guard — reject local-folder + private/non-https URL sources.
      assertAllowedSourceAddress(String(body?.address ?? ''));
      const source = await addSource(body);
      _resetExternalCache();
      warmMarketplaceCatalog();
      return c.json({ source });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'delete',
    path: '/sources/{id}',
    tags: ['marketplace'],
    summary: 'DELETE /marketplace/sources/:id',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Removed source'),
      ...errors(401, 404),
    },
  }),
  async (c: any) => {
    const removed = await removeSource(c.req.param('id'));
    if (!removed) return c.json({ error: 'Not found' }, 404);
    _resetExternalCache();
    warmMarketplaceCatalog();
    return c.json({ ok: true });
  },
);
