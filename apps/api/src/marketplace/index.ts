/**
 * /v1/marketplace — browse the registry catalog. Read-only routes are public; installing
 * is project-scoped and lives at /v1/projects/:id/marketplace/install-session (see projects/routes/marketplace-install-session.ts).
 */

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { requestClientKey } from '../middleware/client-ip';
import { TokenBucketRateLimiter } from '../shared/rate-limit';
import { computeEtag, etagMatches } from '../shared/http-cache';
import type { AppEnv } from '../types';
import {
  _resetExternalCache,
  assertAllowedSourceAddress,
  catalogStatus,
  FEATURED_MARKETPLACES,
  getCatalogItemDetail,
  getCatalogItemFile,
  listCatalogItemsLive,
  listCatalogItemsPage,
  listFeaturedMarketplaces,
  listMarketplaces,
  MARKETPLACE_ITEMS_MAX_LIMIT,
  registerMarketplaceSourceProvider,
  warmMarketplaceCatalog,
} from './catalog';
import { addSource, listSources, removeSource } from './sources-store';
import { readJsonObject } from '../shared/http-body';
import { rethrowDatabaseError } from '../shared/database-errors';

// The browse list is anonymous and can return the whole catalog (6 MB on the
// hosted deployment). A content-addressed ETag makes repeats a 304 and the
// bucket is a backstop against a caller that ignores both cache headers and
// gzip. Replica-local by design (see middleware/rate-limit.ts): the ceiling is
// limit x replicas, which is fine for a read route.
const marketplaceListLimiter = new TokenBucketRateLimiter('marketplace_list');
const MARKETPLACE_LIST_REQS_PER_MIN = 300;

/**
 * Serve a public catalog read with revalidation. `Cache-Control` is public
 * because the body never varies per caller (no auth, no cookies); no
 * `stale-while-revalidate` because a newly indexed source must appear within
 * one max-age window.
 */
function cachedCatalogJson(c: Context<AppEnv>, payload: unknown, maxAgeSeconds: number): Response {
  const etag = computeEtag(payload);
  c.header('Cache-Control', `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds * 4}`);
  c.header('ETag', etag);
  if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
  return c.json(payload as Record<string, unknown>);
}

/** A page query value of decimal digits as a number; null when absent; NaN for anything else. */
function pageQuery(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

// Wire DB-persisted sources into the catalog. Done here (not in catalog.ts) so
// catalog.ts stays free of the config/db import graph for pure unit tests.
registerMarketplaceSourceProvider(listSources);

// Warm the catalog in the background at boot so the first marketplace open is
// instant instead of paying for the cold GitHub scan. The cache lives on
// globalThis, so this also stays warm across `bun --hot` reloads in dev.
warmMarketplaceCatalog();

export const marketplaceApp = makeOpenApiApp<AppEnv>();

const AddMarketplaceSourceBodySchema = z.object({
  address: z.string().min(1),
  gitRef: z.string().optional(),
  sparsePaths: z.array(z.string()).optional(),
  label: z.string().optional(),
});

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/items',
    tags: ['marketplace'],
    summary: 'List marketplace items',
    request: {
      query: z.object({
        query: z.string().optional(),
        type: z.string().optional(),
        source: z.string().optional(),
        limit: z.string().optional().openapi({
          description:
            'Page size, an integer from 1 to 200. Opt-in: omit it for the whole filtered catalog. Any other value answers 400. Items come bundles first, then by name, then by id, so an offset always lands on the same item.',
        }),
        offset: z.string().optional().openapi({
          description: 'Items to skip before the page, an integer from 0. Read only with `limit`. Any other value answers 400. A page past the end is empty.',
        }),
      }),
    },
    responses: {
      200: json(
        z.any(),
        'Catalog items: `{items, total, hasMore, loading, pending, sources}`. A page (`limit` sent) also returns the `limit` and `offset` it applied.',
      ),
      304: { description: 'Not modified — the caller already has this catalog' },
      ...errors(400, 429),
    },
  }),
  async (c: Context<AppEnv>) => {
    const q = c.req.query();
    const limitResult = marketplaceListLimiter.check(requestClientKey(c), {
      limit: MARKETPLACE_LIST_REQS_PER_MIN,
      windowMs: 60_000,
    });
    c.header('X-RateLimit-Limit', String(limitResult.limit));
    c.header('X-RateLimit-Remaining', String(limitResult.remaining));
    if (!limitResult.allowed) {
      c.header(
        'Retry-After',
        String(Math.ceil((limitResult.retryAfterMs ?? limitResult.resetMs) / 1000)),
      );
      return c.json(
        { error: 'rate_limit_exceeded', message: 'Rate limit exceeded. Please retry shortly.' },
        429,
      );
    }
    // Pagination is opt-in: an absent `limit` returns the full filtered list
    // (existing callers, e.g. the web's default-project-skills lookup, filter
    // client-side and rely on getting everything back). A present `limit` must
    // be an integer from 1 to 200, and a present `offset` an integer from 0:
    // anything else answers 400. A typo such as `limit=abc` used to return the
    // whole 6 MB catalog, and `limit=500` was clamped in silence (KRTX-3314).
    //
    // The full list is the expensive response (6 MB on the hosted deployment),
    // so it is served with an ETag: a repeat caller gets a 304 with no body
    // instead of re-transferring the catalog (pentest 2026-10-22, 55,956x
    // amplification). The payload stays byte-identical for clients that do not
    // revalidate.
    const limit = pageQuery(q.limit);
    if (limit !== null && !(limit >= 1 && limit <= MARKETPLACE_ITEMS_MAX_LIMIT)) {
      return c.json({ error: `limit must be an integer from 1 to ${MARKETPLACE_ITEMS_MAX_LIMIT}` }, 400);
    }
    const offset = pageQuery(q.offset) ?? 0;
    if (!Number.isSafeInteger(offset)) return c.json({ error: 'offset must be a non-negative integer' }, 400);
    if (limit !== null) {
      const { items, total } = await listCatalogItemsPage({
        query: q.query,
        type: q.type,
        source: q.source,
        limit,
        offset,
      });
      // `loading`/`pending`/`sources` let the UI stream sources in (Kortix first),
      // poll, and show a spinner per still-resolving source.
      return cachedCatalogJson(
        c,
        { items, total, hasMore: offset + items.length < total, limit, offset, ...catalogStatus() },
        30,
      );
    }
    const items = await listCatalogItemsLive({ query: q.query, type: q.type, source: q.source });
    // `loading`/`pending`/`sources` let the UI stream sources in (Kortix first),
    // poll, and show a spinner per still-resolving source. The full-list variant
    // changes while external sources finish loading, so its window is shorter.
    return cachedCatalogJson(
      c,
      { items, total: items.length, hasMore: false, ...catalogStatus() },
      15,
    );
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/marketplaces',
    tags: ['marketplace'],
    summary: 'List marketplaces',
    responses: {
      200: json(z.any(), 'Distinct marketplaces with item counts'),
    },
  }),
  async (c: Context<AppEnv>) => {
    return c.json({ marketplaces: await listMarketplaces(), ...catalogStatus() });
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/marketplaces/featured',
    tags: ['marketplace'],
    summary: 'List featured marketplaces',
    responses: {
      200: json(z.any(), 'Curated featured marketplaces'),
    },
  }),
  async (c: Context<AppEnv>) => {
    return c.json({ featured: await listFeaturedMarketplaces() });
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/items/{id}',
    tags: ['marketplace'],
    summary: 'Get a marketplace item',
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Item detail'),
      ...errors(404),
    },
  }),
  async (c: Context<AppEnv>) => {
    const detail = await getCatalogItemDetail(c.req.param('id') ?? '');
    if (!detail) return c.json({ error: 'Not found' }, 404);
    return c.json(detail);
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'get',
    path: '/items/{id}/file',
    tags: ['marketplace'],
    summary: 'Read a file of a marketplace item',
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ path: z.string().min(1) }),
    },
    responses: {
      200: json(z.any(), 'File content'),
      ...errors(404),
    },
  }),
  async (c: Context<AppEnv>) => {
    const file = await getCatalogItemFile(c.req.param('id') ?? '', c.req.query('path') ?? '');
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
    summary: 'List marketplace sources',
    ...auth,
    responses: {
      200: json(z.any(), 'Configured marketplace sources'),
      ...errors(401),
    },
  }),
  async (c: Context<AppEnv>) => {
    return c.json({ sources: await listSources() });
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'post',
    path: '/sources',
    tags: ['marketplace'],
    summary: 'Add a marketplace source',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': { schema: AddMarketplaceSourceBodySchema },
        },
      },
    },
    responses: {
      200: json(z.any(), 'Added source'),
      ...errors(400, 401),
    },
  }),
  async (c: Context<AppEnv>) => {
    // The route validator runs only for a JSON content-type, so the handler
    // parses the body with the same schema.
    const parsed = AddMarketplaceSourceBodySchema.safeParse(await readJsonObject(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid marketplace source' }, 400);
    }
    const body = parsed.data;
    // Adding an arbitrary source is admin-only; the curated FEATURED_MARKETPLACES
    // are vetted, public, read-only git repos (they resolve out of the box and
    // carry no SSRF/LFI surface) so any signed-in user may enable one to explore
    // it. See the module-level comment above for the full rationale.
    const address = body.address.trim();
    if (!FEATURED_SOURCE_ADDRESSES.has(address)) {
      // Throws (401/403) on failure — caught by the app's global onError and
      // turned into the right response; resolves to undefined on success.
      await requireAdmin(c, async () => {});
    }
    try {
      // LFI/SSRF guard — reject local-folder + private/non-https URL sources.
      assertAllowedSourceAddress(body.address);
      const source = await addSource(body);
      _resetExternalCache();
      warmMarketplaceCatalog();
      return c.json({ source });
    } catch (err) {
      rethrowDatabaseError(err);
      return c.json({ error: (err as Error).message }, 400);
    }
  },
);

marketplaceApp.openapi(
  createRoute({
    method: 'delete',
    path: '/sources/{id}',
    tags: ['marketplace'],
    summary: 'Remove a marketplace source',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Removed source'),
      ...errors(401, 404),
    },
  }),
  async (c: Context<AppEnv>) => {
    const removed = await removeSource(c.req.param('id') ?? '');
    if (!removed) return c.json({ error: 'Not found' }, 404);
    _resetExternalCache();
    warmMarketplaceCatalog();
    return c.json({ ok: true });
  },
);
