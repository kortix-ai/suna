/**
 * Project-scoped craft routes.
 *
 *   GET  /:projectId/crafts                      → what is installed here
 *   POST /:projectId/crafts/install-session      → start the agent-driven install
 *   POST /:projectId/crafts/:slug/uninstall-session → start the agent-driven removal
 *
 * Installing is agent-driven for the same reason a `registry:project` import is
 * (see `./marketplace-install-prompts.ts`): merging a craft into a LIVE project
 * is judgment-heavy — name collisions, an existing connector that may already
 * hold credentials, a `default_agent` that must not move. So the route starts a
 * session with a generated prompt, and the agent lands a change request a human
 * reviews. The route itself commits nothing.
 *
 * Authorization reuses the existing project permissions rather than inventing
 * `project.craft.*` leaves: the permission catalog is DB-driven, so a new leaf
 * costs a migration plus system-role rows, and the semantics already fit —
 * reading what is installed is `project.read`, and installing writes to the
 * project's repo, which is `project.write`.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { ensureProjectCrafts } from '../craft-catalog';
import { listCraftRuns, summarizeCraftRuns } from '../craft-runs';
import {
  bumpCraftInstallCount,
  craftVisibleTo,
  getCraftById,
  getCraftFiles,
  getCraftManifest,
} from '../craft-store';
import { extractCrafts } from '../crafts';
import { readManifestFromRepo } from '../git/files';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadGitProject } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import { sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';
import { readManifest } from '../triggers';
import {
  type CraftInstallSubject,
  buildCraftInstallPrompt,
  buildCraftUninstallPrompt,
} from './craft-install-prompts';

/** The project's manifest raw text, preferring kortix.yaml (dual-format). */
async function manifestRawOrNull(
  project: Parameters<typeof readManifestFromRepo>[0],
): Promise<string | null> {
  const found = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((cand) => cand.path),
    project.defaultBranch,
  ).catch(() => null);
  return found?.content ?? null;
}

/** Runs paging. Bounded so one call can never ask for a whole history. */
const RUNS_DEFAULT_LIMIT = 50;
const RUNS_MAX_LIMIT = 200;

function runPaging(c: any): { limit: number; offset: number } {
  const rawLimit = Number(c.req.query('limit'));
  const rawOffset = Number(c.req.query('offset'));
  return {
    limit:
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), RUNS_MAX_LIMIT)
        : RUNS_DEFAULT_LIMIT,
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0,
  };
}

/**
 * Membership + flag + capability for a craft READ, in the one order that does
 * not leak: membership first (a stranger gets 404 and learns nothing), then the
 * flag, then the capability.
 *
 * Returns either the resolved scope or the response to send. A discriminated
 * result rather than a throw, so each route's control flow stays readable and
 * the 404/403 bodies stay identical across all of them.
 */
async function requireCraftReadScope(
  c: any,
): Promise<
  | { projectId: string; loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>> }
  | { response: Response }
> {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'crafts');
  if (gate) return { response: gate };
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_READ,
  );
  return { projectId, loaded };
}

// ── GET /:projectId/crafts ──────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/crafts',
    tags: ['crafts'],
    summary: 'GET /:projectId/crafts',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.any(), 'Crafts installed in this project'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scoped = await requireCraftReadScope(c);
    if ('response' in scoped) return scoped.response;
    const { projectId, loaded } = scoped;

    const project = await loadGitProject(loaded);
    let manifest: Awaited<ReturnType<typeof readManifest>> = null;
    let errorsOut: Array<{ slug: string; error: string }> = [];
    let specs: ReturnType<typeof extractCrafts>['specs'] = [];
    try {
      manifest = await readManifest(project);
      if (manifest) {
        const parsed = extractCrafts(manifest);
        specs = parsed.specs;
        errorsOut = parsed.errors.map((e) => ({ slug: e.slug, error: e.error }));
      }
    } catch (err) {
      // A git read failure is reported, never treated as "no crafts installed".
      errorsOut = [{ slug: '(manifest)', error: err instanceof Error ? err.message : String(err) }];
    }

    // Converge the projection from this read, non-destructively: another API
    // task may be mid-commit, and a READ must never uninstall a craft.
    if (manifest) await ensureProjectCrafts(projectId, specs);

    return c.json({
      crafts: specs.map((spec) => ({
        slug: spec.slug,
        repo: `${spec.repoOwner}/${spec.repoName}`,
        git_ref: spec.gitRef,
        sha: spec.resolvedSha,
        version: spec.version,
        title: spec.title,
        installed_at: spec.installedAt,
        owns: spec.owns,
      })),
      errors: errorsOut,
    });
  },
);

// ── POST /:projectId/crafts/install-session ─────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/crafts/install-session',
    tags: ['crafts'],
    summary: 'POST /:projectId/crafts/install-session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Install session started'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Membership authz BEFORE the flag gate, so a stranger gets 404 rather than
    // learning whether this project has crafts enabled.
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'crafts');
    if (gate) return gate;
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_WRITE,
    );

    const body = await readBody(c);
    const craftId = typeof body?.craft_id === 'string' ? body.craft_id.trim() : '';
    if (!craftId) return c.json({ error: 'craft_id is required' }, 400);

    const craft = await getCraftById(craftId);
    // Same 404-not-403 rule as the index: a 403 would confirm the id exists.
    if (!craft || !craftVisibleTo(craft, loaded.row.accountId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (craft.status !== 'active') {
      return c.json(
        {
          error: `"${craft.title}" is ${craft.status} and cannot be installed`,
          code: `craft_${craft.status}`,
          ...(craft.last_error ? { detail: craft.last_error } : {}),
        },
        400,
      );
    }

    const project = await loadGitProject(loaded);
    const subject: CraftInstallSubject = {
      slug: craft.slug,
      title: craft.title,
      description: craft.description,
      sourceKind: craft.source_kind,
      repoOwner: craft.repo_owner,
      repoName: craft.repo_name,
      uploadName: craft.upload_name,
      gitRef: craft.git_ref,
      resolvedSha: craft.resolved_sha,
      // An upload has no repo to fetch from, so its files travel in the prompt.
      // Read only for that source: a github craft's `files` column is empty and
      // the query would be pure waste on every install.
      files: craft.source_kind === 'upload' ? await getCraftFiles(craftId) : [],
      // The cached manifest, so the agent reads one authoritative copy rather
      // than fetching and possibly disagreeing with the card it was shown.
      manifest: (await getCraftManifest(craftId)) ?? {},
      agents: (craft.agents as Array<{ name: string }>) ?? [],
      triggers: (craft.triggers as Array<{ slug: string }>) ?? [],
      connectors: (craft.connectors as Array<{ slug: string }>) ?? [],
      skills: craft.skills ?? [],
      envRequired: craft.env_required ?? [],
    };

    const result = await createSession({
      source: 'ui',
      project: loaded.row,
      userId: loaded.userId,
      requestingPrincipalType:
        c.get('authType') === 'service_account' ? 'service_account' : 'human',
      body: {
        initial_prompt: buildCraftInstallPrompt(subject, await manifestRawOrNull(project)),
        name: `Install ${craft.title}`,
        // `craft_slug` is server-managed (see project-sessions.ts): a client
        // must not be able to attribute its own session to a craft and inherit
        // that craft's run report.
        metadata: {
          kind: 'craft-install',
          craft_slug: craft.slug,
          craft_id: craft.craft_id,
          craft_repo: craft.repo,
          ...(craft.resolved_sha ? { craft_sha: craft.resolved_sha } : {}),
        },
      },
      visibility: 'project',
      authType: c.get('authType') as string | undefined,
      apiKeyType: c.get('apiKeyType') as string | undefined,
      inSession: isProjectSessionPrincipal(c),
      request: requestAuditContext(c),
      queuePolicy: 'never',
    });
    if (result.error) return sendSessionCreateError(c, result.error);
    if (!result.row) return c.json({ error: 'Session creation returned no row' }, 500);

    // Best-effort, and deliberately counted at START rather than at merge: this
    // is "installs started". Counting at merge would need a hook on the CR
    // path, and would report 0 for every install still in review.
    void bumpCraftInstallCount(craft.craft_id).catch((err) =>
      console.warn('[crafts] install count bump failed', craft.craft_id, err),
    );

    return c.json({ session_id: result.row.sessionId }, 201);
  },
);

// ── POST /:projectId/crafts/:slug/uninstall-session ─────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/crafts/{slug}/uninstall-session',
    tags: ['crafts'],
    summary: 'POST /:projectId/crafts/:slug/uninstall-session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Uninstall session started'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'crafts');
    if (gate) return gate;
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_WRITE,
    );

    const project = await loadGitProject(loaded);
    const manifestRaw = await manifestRawOrNull(project);
    // The manifest is the source of truth for what is installed — not
    // `project_crafts`, which is a projection that a stale read could lag.
    const manifest = await readManifest(project).catch(() => null);
    const installed = manifest ? extractCrafts(manifest).specs.find((s) => s.slug === slug) : null;
    if (!installed) {
      return c.json({ error: `No craft "${slug}" is installed in this project` }, 404);
    }

    const result = await createSession({
      source: 'ui',
      project: loaded.row,
      userId: loaded.userId,
      requestingPrincipalType:
        c.get('authType') === 'service_account' ? 'service_account' : 'human',
      body: {
        initial_prompt: buildCraftUninstallPrompt(
          {
            slug: installed.slug,
            title: installed.title,
            repoOwner: installed.repoOwner,
            repoName: installed.repoName,
            owns: installed.owns,
          },
          manifestRaw,
        ),
        name: `Remove ${installed.title}`,
        metadata: {
          kind: 'craft-uninstall',
          craft_slug: installed.slug,
          craft_repo: `${installed.repoOwner}/${installed.repoName}`,
        },
      },
      visibility: 'project',
      authType: c.get('authType') as string | undefined,
      apiKeyType: c.get('apiKeyType') as string | undefined,
      inSession: isProjectSessionPrincipal(c),
      request: requestAuditContext(c),
      queuePolicy: 'never',
    });
    if (result.error) return sendSessionCreateError(c, result.error);
    if (!result.row) return c.json({ error: 'Session creation returned no row' }, 500);

    return c.json({ session_id: result.row.sessionId }, 201);
  },
);

// ── GET /:projectId/crafts/runs ─────────────────────────────────────────────
//
// Registered BEFORE `/{projectId}/crafts/{slug}/runs` so `runs` is never eaten
// as a craft slug. (`activation` vs `{slug}` in r4.ts is the same ordering
// hazard, and carries the same note.)

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/crafts/runs',
    tags: ['crafts'],
    summary: "GET /:projectId/crafts/runs — every craft's runs",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ limit: z.string().optional(), offset: z.string().optional() }),
    },
    responses: {
      200: json(z.any(), 'Runs across every installed craft'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scoped = await requireCraftReadScope(c);
    if ('response' in scoped) return scoped.response;
    const { limit, offset } = runPaging(c);
    const { runs, total } = await listCraftRuns({
      projectId: scoped.projectId,
      limit,
      offset,
    });
    return c.json({ runs, total, limit, offset });
  },
);

// ── GET /:projectId/crafts/{slug}/runs ──────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/crafts/{slug}/runs',
    tags: ['crafts'],
    summary: 'GET /:projectId/crafts/:slug/runs',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
      query: z.object({ limit: z.string().optional(), offset: z.string().optional() }),
    },
    responses: {
      200: json(z.any(), 'Runs for one craft, with aggregate stats'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scoped = await requireCraftReadScope(c);
    if ('response' in scoped) return scoped.response;
    const slug = c.req.param('slug');
    const { limit, offset } = runPaging(c);
    const { runs, total } = await listCraftRuns({
      projectId: scoped.projectId,
      craftSlug: slug,
      limit,
      offset,
    });
    // Stats are over the RETURNED page, not the whole history, and the response
    // says so via `total`. Aggregating every execution ever would be a second
    // full scan for a number the report shows beside a 12-run strip.
    return c.json({
      craft_slug: slug,
      runs,
      total,
      limit,
      offset,
      stats: summarizeCraftRuns(runs),
    });
  },
);
