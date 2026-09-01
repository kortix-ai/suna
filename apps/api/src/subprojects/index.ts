/**
 * `/v1/subprojects` — the subproject index.
 *
 * A subproject is a GitHub repo whose own `kortix.yaml` declares agents, triggers
 * and connectors. These routes are the CATALOGUE: submit a repo, browse what
 * is submitted, withdraw one. Installing a subproject is project-scoped and lives at
 * `/v1/projects/:id/subprojects/install-session`.
 *
 * Kortix indexes; git hosts. Every card here is derived from one commit of a
 * public repo, and every write goes through the crawl — a card cannot be
 * hand-authored, so the store cannot advertise a subproject the runtime would refuse.
 *
 * Authorization deliberately reuses the EXISTING account permissions rather
 * than inventing `subproject.*` leaves. The permission catalog is DB-driven, so a
 * new action costs a migration plus system-role rows; and the semantics already
 * fit: browsing the catalogue is `account.read`, and adding a subproject to your
 * account's catalogue is a change to that account's configuration —
 * `account.write`. Ownership (who may delete) is enforced in the store by
 * `account_id`, not by a permission.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { actorOf, authorize } from '../iam';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import { combinedAuth } from '../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { SubprojectCrawlError, crawlSubprojectRepo, crawlSubprojectZip } from '../projects/subproject-index';
import {
  SUBPROJECT_INSTALL_EMBED_BUDGET,
  subprojectExceedsEmbedBudget,
} from '../projects/routes/subproject-install-prompts';
import {
  subprojectVisibleTo,
  deleteSubproject,
  getSubprojectById,
  listSubprojects,
  upsertSubprojectFromCrawl,
} from '../projects/subproject-store';
import { resolveProjectAccount } from '../projects/lib/access';
import { readBody } from '../projects/lib/serializers';
import type { AppEnv } from '../types';

export const subprojectsApp = makeOpenApiApp<AppEnv>();

// `combinedAuth`, not `supabaseAuth`: the CLI publishes a subproject with an account
// PAT, and the web app with a Supabase JWT. A PROJECT-scoped token is still
// refused by `enforceTokenProjectScope`, which is default-deny and deliberately
// does not whitelist this surface — a session-bound sandbox credential has no
// business writing its account's catalogue.
subprojectsApp.use('/*', combinedAuth);

/**
 * Largest archive accepted, checked on the DECLARED size before any read.
 * Generous next to `SUBPROJECT_ZIP_LIMITS` (5 MB of text): a real repo zip carries
 * lockfiles and images we skip, so the compressed envelope is legitimately
 * bigger than the text we keep.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
function crawlErrorResponse(c: any, err: SubprojectCrawlError) {
  const body: Record<string, unknown> = { error: err.message, code: err.code };
  // Manifest findings are the whole value of the rejection: the submitter needs
  // the offending paths, not "invalid manifest".
  if (err.issues.length > 0) body.issues = err.issues;
  return c.json(body, err.code === 'upstream_unavailable' ? 502 : 400);
}

// ── GET /v1/subprojects ──────────────────────────────────────────────────────────

subprojectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['subprojects'],
    summary: 'GET /subprojects',
    ...auth,
    request: {
      query: z.object({
        q: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
    responses: {
      200: json(z.any(), 'Subprojects visible to the caller'),
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
    const { items, total } = await listSubprojects({
      accountId: scope.accountId,
      q: c.req.query('q') ?? null,
      limit,
      offset,
    });
    return c.json({ subprojects: items, total, limit, offset });
  },
);

// ── POST /v1/subprojects ─────────────────────────────────────────────────────────

subprojectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['subprojects'],
    summary: 'POST /subprojects',
    ...auth,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              /**
               * `owner/repo`, optionally `@branch-or-tag`; a browser or clone
               * URL also works. OPTIONAL at the schema level because the same
               * route also accepts a multipart .zip — if it were required here
               * the validator would reject an upload before the handler ran,
               * and answer "repo: Required" instead of explaining both shapes.
               */
              repo: z.string().min(1).optional(),
              visibility: z.enum(['public', 'private']).optional(),
              account_id: z.string().optional(),
            }),
          },
          // A .zip upload takes the same route. Declared so the published spec
          // shows both shapes rather than implying JSON is the only one.
          'multipart/form-data': {
            schema: z.object({
              file: z.any().openapi({ type: 'string', format: 'binary' }),
              visibility: z.enum(['public', 'private']).optional(),
              account_id: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(z.any(), 'Subproject indexed'),
      ...errors(400, 401, 403, 502),
    },
  }),
  async (c: any) => {
    // Two shapes on one route: JSON `{ repo }` for a GitHub subproject, and
    // multipart with a `file` part for an uploaded .zip. One route because it is
    // one action — "add this subproject to my catalogue" — and the caller should not
    // have to know which storage model Kortix uses underneath.
    const contentType = c.req.header('content-type') ?? '';
    const isMultipart = contentType.includes('multipart/form-data');

    let body: Record<string, unknown> = {};
    let upload: { bytes: ArrayBuffer; name: string } | null = null;

    if (isMultipart) {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return c.json({ error: 'Malformed multipart body', code: 'invalid_archive' }, 400);
      }
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return c.json(
          { error: 'Attach the archive as the `file` part', code: 'invalid_archive' },
          400,
        );
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        // Refused on the DECLARED size before reading, so a hostile upload
        // never gets to allocate. The zip reader bounds the uncompressed side.
        return c.json(
          {
            error: `Archive is ${file.size} bytes; the limit is ${MAX_UPLOAD_BYTES}`,
            code: 'archive_refused',
          },
          400,
        );
      }
      upload = { bytes: await file.arrayBuffer(), name: file.name || 'subproject.zip' };
      for (const key of ['visibility', 'account_id']) {
        const value = form.get(key);
        if (typeof value === 'string') body[key] = value;
      }
    } else {
      body = await readBody(c);
    }

    const scope = await resolveProjectAccount(c, body);
    if (
      !(await authorize(await actorOf(c, scope.accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE)).allowed
    ) {
      return c.json({ error: 'Owner or admin role required' }, 403);
    }

    // Private by default. A subproject becomes public because someone chose to
    // publish it, never because they forgot to say otherwise.
    const visibility = body?.visibility === 'public' ? 'public' : 'private';

    let crawl: Awaited<ReturnType<typeof crawlSubprojectRepo>>;
    try {
      if (upload) {
        crawl = crawlSubprojectZip(upload.bytes, upload.name);
      } else {
        const repo = typeof body?.repo === 'string' ? body.repo.trim() : '';
        if (!repo) {
          return c.json(
            {
              error: 'Send a `repo`, or upload an archive as the `file` part',
              code: 'invalid_address',
            },
            400,
          );
        }
        crawl = await crawlSubprojectRepo(repo);
      }
    } catch (err) {
      if (err instanceof SubprojectCrawlError) return crawlErrorResponse(c, err);
      throw err;
    }

    const subproject = await upsertSubprojectFromCrawl({
      crawl,
      visibility,
      accountId: scope.accountId,
      submittedBy: scope.userId,
    });
    // Warnings are advisory and never block: a subproject whose manifest carries a
    // deprecation notice is still installable, and the submitter should see why
    // it was flagged rather than have it silently swallowed.
    const warnings = [...crawl.warnings];
    // An upload's files travel to the install agent inside the prompt, which is
    // a tighter bound than the archive cap. Say so HERE, at submit, rather than
    // letting the author discover it when an install reports the subproject
    // incomplete.
    if (crawl.sourceKind === 'upload' && subprojectExceedsEmbedBudget(crawl.files ?? [])) {
      warnings.push(
        `This subproject carries more than ${Math.round(SUBPROJECT_INSTALL_EMBED_BUDGET / 1000)} KB of text. ` +
          'It is indexed, but an install can only embed part of it — an uploaded subproject has no ' +
          'repository to read the rest from. Publish it from a GitHub repo, or trim it, to install it whole.',
      );
    }
    return c.json({ subproject, warnings }, 201);
  },
);

// ── GET /v1/subprojects/{subprojectId} ────────────────────────────────────────────────

subprojectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{subprojectId}',
    tags: ['subprojects'],
    summary: 'GET /subprojects/:subprojectId',
    ...auth,
    request: { params: z.object({ subprojectId: z.string() }) },
    responses: {
      200: json(z.any(), 'The subproject'),
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
    const subproject = await getSubprojectById(c.req.param('subprojectId'));
    // A subproject the caller may not see is 404, not 403: a 403 would confirm the
    // id exists, which leaks another account's private catalogue.
    if (!subproject || !subprojectVisibleTo(subproject, scope.accountId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json({ subproject });
  },
);

// ── DELETE /v1/subprojects/{subprojectId} ─────────────────────────────────────────────

subprojectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{subprojectId}',
    tags: ['subprojects'],
    summary: 'DELETE /subprojects/:subprojectId',
    ...auth,
    request: { params: z.object({ subprojectId: z.string() }) },
    responses: {
      200: json(z.any(), 'Subproject removed from the index'),
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
    const subprojectId = c.req.param('subprojectId');
    const subproject = await getSubprojectById(subprojectId);
    if (!subproject || !subprojectVisibleTo(subproject, scope.accountId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    // Owner-scoped in the store too, so a subproject published by Kortix
    // (`account_id IS NULL`) or by another account can never be removed here.
    const removed = await deleteSubproject(subprojectId, scope.accountId);
    if (!removed) {
      return c.json({ error: 'Only the submitting account can remove this subproject' }, 403);
    }
    // Removing the catalogue entry does NOT uninstall the subproject anywhere: an
    // install is recorded in the project's own manifest, and
    // `project_subprojects.subproject_id` is ON DELETE SET NULL precisely so the install
    // outlives its listing.
    return c.json({ ok: true });
  },
);
