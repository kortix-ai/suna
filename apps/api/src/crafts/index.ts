/**
 * `/v1/crafts` — the craft index.
 *
 * A craft is a GitHub repo whose own `kortix.yaml` declares agents, triggers
 * and connectors. These routes are the CATALOGUE: submit a repo, browse what
 * is submitted, withdraw one. Installing a craft is project-scoped and lives at
 * `/v1/projects/:id/crafts/install-session`.
 *
 * Kortix indexes; git hosts. Every card here is derived from one commit of a
 * public repo, and every write goes through the crawl — a card cannot be
 * hand-authored, so the store cannot advertise a craft the runtime would refuse.
 *
 * Authorization deliberately reuses the EXISTING account permissions rather
 * than inventing `craft.*` leaves. The permission catalog is DB-driven, so a
 * new action costs a migration plus system-role rows; and the semantics already
 * fit: browsing the catalogue is `account.read`, and adding a craft to your
 * account's catalogue is a change to that account's configuration —
 * `account.write`. Ownership (who may delete) is enforced in the store by
 * `account_id`, not by a permission.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { actorOf, authorize } from '../iam';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import { combinedAuth } from '../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { CraftCrawlError, crawlCraftRepo } from '../projects/craft-index';
import {
  craftVisibleTo,
  deleteCraft,
  getCraftById,
  listCrafts,
  upsertCraftFromCrawl,
} from '../projects/craft-store';
import { resolveProjectAccount } from '../projects/lib/access';
import { readBody } from '../projects/lib/serializers';
import type { AppEnv } from '../types';

export const craftsApp = makeOpenApiApp<AppEnv>();

// `combinedAuth`, not `supabaseAuth`: the CLI publishes a craft with an account
// PAT, and the web app with a Supabase JWT. A PROJECT-scoped token is still
// refused by `enforceTokenProjectScope`, which is default-deny and deliberately
// does not whitelist this surface — a session-bound sandbox credential has no
// business writing its account's catalogue.
craftsApp.use('/*', combinedAuth);

/** Page size. Bounded so one call can never ask for the whole catalogue. */
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
 * Map a crawl failure to a status + body.
 *
 * Every code here is a statement about the CALLER'S INPUT, so each is a 400
 * carrying the reason — never a 5xx. `upstream_unavailable` is the one
 * exception: GitHub being down is not the caller's fault, and 502 is the honest
 * answer (a 400 would tell them to fix a repo that is fine).
 */
function crawlErrorResponse(c: any, err: CraftCrawlError) {
  const body: Record<string, unknown> = { error: err.message, code: err.code };
  // Manifest findings are the whole value of the rejection: the submitter needs
  // the offending paths, not "invalid manifest".
  if (err.issues.length > 0) body.issues = err.issues;
  return c.json(body, err.code === 'upstream_unavailable' ? 502 : 400);
}

// ── GET /v1/crafts ──────────────────────────────────────────────────────────

craftsApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['crafts'],
    summary: 'GET /crafts',
    ...auth,
    request: {
      query: z.object({
        q: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.any(), 'Crafts visible to the caller'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
    const scope = await resolveProjectAccount(c);
    if (
      !(await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_READ)).allowed
    ) {
      return c.json({ error: 'Account membership required' }, 403);
    }
    const limit = clampLimit(c.req.query('limit'));
    const offset = clampOffset(c.req.query('offset'));
    const { items, total } = await listCrafts({
      accountId: scope.accountId,
      q: c.req.query('q') ?? null,
      limit,
      offset,
    });
    return c.json({ crafts: items, total, limit, offset });
  },
);

// ── POST /v1/crafts ─────────────────────────────────────────────────────────

craftsApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['crafts'],
    summary: 'POST /crafts',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              /** `owner/repo`, optionally `@branch-or-tag`; a browser or clone URL also works. */
              repo: z.string().min(1),
              visibility: z.enum(['public', 'private']).optional(),
              account_id: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(z.any(), 'Craft indexed'),
      ...errors(400, 401, 403, 502),
    },
  }),
  async (c: any) => {
    const body = await readBody(c);
    const scope = await resolveProjectAccount(c, body);
    if (
      !(await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed
    ) {
      return c.json({ error: 'Owner or admin role required' }, 403);
    }

    const repo = typeof body?.repo === 'string' ? body.repo.trim() : '';
    if (!repo) return c.json({ error: 'repo is required', code: 'invalid_address' }, 400);
    // Private by default. A craft becomes public because someone chose to
    // publish it, never because they forgot to say otherwise.
    const visibility = body?.visibility === 'public' ? 'public' : 'private';

    let crawl: Awaited<ReturnType<typeof crawlCraftRepo>>;
    try {
      crawl = await crawlCraftRepo(repo);
    } catch (err) {
      if (err instanceof CraftCrawlError) return crawlErrorResponse(c, err);
      throw err;
    }

    const craft = await upsertCraftFromCrawl({
      crawl,
      visibility,
      accountId: scope.accountId,
      submittedBy: scope.userId,
    });
    // Warnings are advisory and never block: a craft whose manifest carries a
    // deprecation notice is still installable, and the submitter should see why
    // it was flagged rather than have it silently swallowed.
    return c.json({ craft, warnings: crawl.warnings }, 201);
  },
);

// ── GET /v1/crafts/{craftId} ────────────────────────────────────────────────

craftsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{craftId}',
    tags: ['crafts'],
    summary: 'GET /crafts/:craftId',
    ...auth,
    request: { params: z.object({ craftId: z.string() }) },
    responses: {
      200: json(z.any(), 'The craft'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scope = await resolveProjectAccount(c);
    if (
      !(await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_READ)).allowed
    ) {
      return c.json({ error: 'Account membership required' }, 403);
    }
    const craft = await getCraftById(c.req.param('craftId'));
    // A craft the caller may not see is 404, not 403: a 403 would confirm the
    // id exists, which leaks another account's private catalogue.
    if (!craft || !craftVisibleTo(craft, scope.accountId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json({ craft });
  },
);

// ── DELETE /v1/crafts/{craftId} ─────────────────────────────────────────────

craftsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{craftId}',
    tags: ['crafts'],
    summary: 'DELETE /crafts/:craftId',
    ...auth,
    request: { params: z.object({ craftId: z.string() }) },
    responses: {
      200: json(z.any(), 'Craft removed from the index'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scope = await resolveProjectAccount(c);
    if (
      !(await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed
    ) {
      return c.json({ error: 'Owner or admin role required' }, 403);
    }
    const craftId = c.req.param('craftId');
    const craft = await getCraftById(craftId);
    if (!craft || !craftVisibleTo(craft, scope.accountId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    // Owner-scoped in the store too, so a craft published by Kortix
    // (`account_id IS NULL`) or by another account can never be removed here.
    const removed = await deleteCraft(craftId, scope.accountId);
    if (!removed) {
      return c.json({ error: 'Only the submitting account can remove this craft' }, 403);
    }
    // Removing the catalogue entry does NOT uninstall the craft anywhere: an
    // install is recorded in the project's own manifest, and
    // `project_crafts.craft_id` is ON DELETE SET NULL precisely so the install
    // outlives its listing.
    return c.json({ ok: true });
  },
);
