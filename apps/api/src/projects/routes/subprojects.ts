/**
 * Project-scoped subproject routes.
 *
 *   GET   /:projectId/subprojects                      → what is installed here
 *   POST  /:projectId/subprojects/install-session      → start the agent-driven install
 *   POST  /:projectId/subprojects/author-session       → start the agent-driven authoring
 *   POST  /:projectId/subprojects/:slug/uninstall-session → start the agent-driven removal
 *   PATCH /:projectId/subprojects/:slug/activation     → enable/disable its triggers
 *   GET   /:projectId/subprojects/runs                 → every subproject's runs
 *   GET   /:projectId/subprojects/:slug/runs           → one subproject's runs
 *
 * Installing is agent-driven because merging a subproject into a LIVE project
 * is judgment-heavy — name collisions, an existing connector that may already
 * hold credentials, a `default_agent` that must not move. So the route starts a
 * session with a generated prompt, and the agent lands a change request a human
 * reviews. The route itself commits nothing.
 *
 * Authorization reuses the existing project permissions rather than inventing
 * `project.subproject.*` leaves: the permission catalog is DB-driven, so a new leaf
 * costs a migration plus system-role rows, and the semantics already fit —
 * reading what is installed is `project.read`, and installing writes to the
 * project's repo, which is `project.write`.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { mutateManifestWithRetry } from '../../connectors/manifest-mutation';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import { ensureProjectSubprojects } from '../subproject-catalog';
import { listSubprojectRuns, summarizeSubprojectRuns } from '../subproject-runs';
import {
  bumpSubprojectInstallCount,
  subprojectVisibleTo,
  getSubprojectById,
  getSubprojectFiles,
  getSubprojectManifest,
} from '../subproject-store';
import {
  subprojectTriggerActivation,
  extractSubprojects,
  setSubprojectTriggersEnabled,
} from '../subprojects';
import { reconcileProjectTriggerRuntime } from '../trigger-runtime-catalog';
import { readManifestFromRepo } from '../git/files';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadGitProject } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import { sendSessionCreateError } from '../lib/sessions';
import { createSession } from '../session-lifecycle';
import { extractTriggers, readManifest } from '../triggers';
import {
  type SubprojectInstallSubject,
  buildSubprojectAuthorPrompt,
  buildSubprojectInstallPrompt,
  buildSubprojectUninstallPrompt,
} from './subproject-install-prompts';

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
 * Membership + flag + capability for a subproject READ, in the one order that does
 * not leak: membership first (a stranger gets 404 and learns nothing), then the
 * flag, then the capability.
 *
 * Returns either the resolved scope or the response to send. A discriminated
 * result rather than a throw, so each route's control flow stays readable and
 * the 404/403 bodies stay identical across all of them.
 */
async function requireSubprojectReadScope(
  c: any,
): Promise<
  | { projectId: string; loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>> }
  | { response: Response }
> {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'subprojects');
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

// ── GET /:projectId/subprojects ──────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/subprojects',
    tags: ['subprojects'],
    summary: 'GET /:projectId/subprojects',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(z.any(), 'Subprojects installed in this project'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scoped = await requireSubprojectReadScope(c);
    if ('response' in scoped) return scoped.response;
    const { projectId, loaded } = scoped;

    const project = await loadGitProject(loaded);
    let manifest: Awaited<ReturnType<typeof readManifest>> = null;
    let errorsOut: Array<{ slug: string; error: string }> = [];
    let specs: ReturnType<typeof extractSubprojects>['specs'] = [];
    try {
      manifest = await readManifest(project);
      if (manifest) {
        const parsed = extractSubprojects(manifest);
        specs = parsed.specs;
        errorsOut = parsed.errors.map((e) => ({ slug: e.slug, error: e.error }));
      }
    } catch (err) {
      // A git read failure is reported, never treated as "no subprojects installed".
      errorsOut = [{ slug: '(manifest)', error: err instanceof Error ? err.message : String(err) }];
    }

    // Converge the projection from this read, non-destructively: another API
    // task may be mid-commit, and a READ must never uninstall a subproject.
    if (manifest) await ensureProjectSubprojects(projectId, specs);

    return c.json({
      subprojects: specs.map((spec) => {
        // Activation is DERIVED from the subproject's trigger entries in this same
        // manifest — there is no stored "this subproject is on" flag, and a second
        // copy is how the switch and the trigger list end up disagreeing.
        // `enabled: null` means mixed, or no triggers at all; a UI must render
        // that as indeterminate rather than guessing on or off.
        const activation = manifest
          ? subprojectTriggerActivation(manifest, spec.slug)
          : { enabled: null, triggerCount: 0, enabledCount: 0 };
        return {
          slug: spec.slug,
          repo: `${spec.repoOwner}/${spec.repoName}`,
          git_ref: spec.gitRef,
          sha: spec.resolvedSha,
          version: spec.version,
          title: spec.title,
          installed_at: spec.installedAt,
          owns: spec.owns,
          enabled: activation.enabled,
          trigger_count: activation.triggerCount,
          enabled_trigger_count: activation.enabledCount,
        };
      }),
      errors: errorsOut,
    });
  },
);

// ── POST /:projectId/subprojects/install-session ─────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/subprojects/install-session',
    tags: ['subprojects'],
    summary: 'POST /:projectId/subprojects/install-session',
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
    // learning whether this project has subprojects enabled.
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'subprojects');
    if (gate) return gate;
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_WRITE,
    );

    const body = await readBody(c);
    const subprojectId = typeof body?.subproject_id === 'string' ? body.subproject_id.trim() : '';
    if (!subprojectId) return c.json({ error: 'subproject_id is required' }, 400);

    const subproject = await getSubprojectById(subprojectId);
    // Same 404-not-403 rule as the index: a 403 would confirm the id exists.
    if (!subproject || !subprojectVisibleTo(subproject, loaded.row.accountId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (subproject.status !== 'active') {
      return c.json(
        {
          error: `"${subproject.title}" is ${subproject.status} and cannot be installed`,
          code: `subproject_${subproject.status}`,
          ...(subproject.last_error ? { detail: subproject.last_error } : {}),
        },
        400,
      );
    }

    // `kortix.yaml` IS the subproject: it declares the agents, skills,
    // connectors and triggers the install merges. So it is a REQUIREMENT here,
    // not a field with a fallback. The `?? {}` this replaced would start a real
    // session, hand the agent an empty manifest, and report success for an
    // install that merged nothing.
    //
    // The crawl already refuses a source with no manifest
    // (`manifest_not_found`) and one that declares nothing
    // (`manifest_invalid`), both 400, so an `active` row always carries one.
    // This gate covers what the crawl cannot: the row being deleted between
    // the read above and this one, and any future writer that skips the
    // column — it is `jsonb DEFAULT '{}' NOT NULL`, so a missed write reads
    // back as `{}` rather than NULL and no type would catch it.
    const subprojectManifest = await getSubprojectManifest(subprojectId);
    if (!subprojectManifest || Object.keys(subprojectManifest).length === 0) {
      return c.json(
        {
          error: `"${subproject.title}" has no kortix.yaml — a subproject must declare one before it can be installed`,
          code: 'manifest_not_found',
        },
        400,
      );
    }

    const project = await loadGitProject(loaded);
    const subject: SubprojectInstallSubject = {
      slug: subproject.slug,
      title: subproject.title,
      description: subproject.description,
      sourceKind: subproject.source_kind,
      repoOwner: subproject.repo_owner,
      repoName: subproject.repo_name,
      uploadName: subproject.upload_name,
      gitRef: subproject.git_ref,
      resolvedSha: subproject.resolved_sha,
      // An upload has no repo to fetch from, so its files travel in the prompt.
      // Read only for that source: a github subproject's `files` column is empty and
      // the query would be pure waste on every install.
      files: subproject.source_kind === 'upload' ? await getSubprojectFiles(subprojectId) : [],
      // The cached manifest, so the agent reads one authoritative copy rather
      // than fetching and possibly disagreeing with the card it was shown.
      // Non-empty by the gate above.
      manifest: subprojectManifest,
      agents: (subproject.agents as Array<{ name: string }>) ?? [],
      triggers: (subproject.triggers as Array<{ slug: string }>) ?? [],
      connectors: (subproject.connectors as Array<{ slug: string }>) ?? [],
      skills: subproject.skills ?? [],
      envRequired: subproject.env_required ?? [],
    };

    const result = await createSession({
      source: 'ui',
      project: loaded.row,
      userId: loaded.userId,
      requestingPrincipalType:
        c.get('authType') === 'service_account' ? 'service_account' : 'human',
      body: {
        initial_prompt: buildSubprojectInstallPrompt(subject, await manifestRawOrNull(project)),
        // "Install subproject <title>", not "Install <title>": the session list mixes
        // subproject installs with ordinary work, and the
        // noun is what makes a row scannable.
        name: `Install subproject ${subproject.title}`,
        // `subproject_slug` is server-managed (see project-sessions.ts): a client
        // must not be able to attribute its own session to a subproject and inherit
        // that subproject's run report.
        metadata: {
          kind: 'subproject-install',
          subproject_slug: subproject.slug,
          subproject_id: subproject.subproject_id,
          subproject_repo: subproject.repo,
          ...(subproject.resolved_sha ? { subproject_sha: subproject.resolved_sha } : {}),
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
    void bumpSubprojectInstallCount(subproject.subproject_id).catch((err) =>
      console.warn('[subprojects] install count bump failed', subproject.subproject_id, err),
    );

    return c.json({ session_id: result.row.sessionId }, 201);
  },
);

// ── POST /:projectId/subprojects/:slug/uninstall-session ─────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/subprojects/{slug}/uninstall-session',
    tags: ['subprojects'],
    summary: 'POST /:projectId/subprojects/:slug/uninstall-session',
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
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'subprojects');
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
    // `project_subprojects`, which is a projection that a stale read could lag.
    const manifest = await readManifest(project).catch(() => null);
    const installed = manifest
      ? extractSubprojects(manifest).specs.find((s) => s.slug === slug)
      : null;
    if (!installed) {
      return c.json({ error: `No subproject "${slug}" is installed in this project` }, 404);
    }

    const result = await createSession({
      source: 'ui',
      project: loaded.row,
      userId: loaded.userId,
      requestingPrincipalType:
        c.get('authType') === 'service_account' ? 'service_account' : 'human',
      body: {
        initial_prompt: buildSubprojectUninstallPrompt(
          {
            slug: installed.slug,
            title: installed.title,
            repoOwner: installed.repoOwner,
            repoName: installed.repoName,
            owns: installed.owns,
          },
          manifestRaw,
        ),
        // Mirrors the install title's shape — same reason.
        name: `Uninstall subproject ${installed.title}`,
        metadata: {
          kind: 'subproject-uninstall',
          subproject_slug: installed.slug,
          subproject_repo: `${installed.repoOwner}/${installed.repoName}`,
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

// ── GET /:projectId/subprojects/runs ─────────────────────────────────────────────
//
// Registered BEFORE `/{projectId}/subprojects/{slug}/runs` so `runs` is never eaten
// as a subproject slug. (`activation` vs `{slug}` in r4.ts is the same ordering
// hazard, and carries the same note.)

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/subprojects/runs',
    tags: ['subprojects'],
    summary: "GET /:projectId/subprojects/runs — every subproject's runs",
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({ limit: z.string().optional(), offset: z.string().optional() }),
    },
    responses: {
      200: json(z.any(), 'Runs across every installed subproject'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scoped = await requireSubprojectReadScope(c);
    if ('response' in scoped) return scoped.response;
    const { limit, offset } = runPaging(c);
    const { runs, total } = await listSubprojectRuns({
      projectId: scoped.projectId,
      limit,
      offset,
    });
    return c.json({ runs, total, limit, offset });
  },
);

// ── GET /:projectId/subprojects/{slug}/runs ──────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/subprojects/{slug}/runs',
    tags: ['subprojects'],
    summary: 'GET /:projectId/subprojects/:slug/runs',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
      query: z.object({ limit: z.string().optional(), offset: z.string().optional() }),
    },
    responses: {
      200: json(z.any(), 'Runs for one subproject, with aggregate stats'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const scoped = await requireSubprojectReadScope(c);
    if ('response' in scoped) return scoped.response;
    const slug = c.req.param('slug');
    const { limit, offset } = runPaging(c);
    const { runs, total } = await listSubprojectRuns({
      projectId: scoped.projectId,
      subprojectSlug: slug,
      limit,
      offset,
    });
    // Stats are over the RETURNED page, not the whole history, and the response
    // says so via `total`. Aggregating every execution ever would be a second
    // full scan for a number the report shows beside a 12-run strip.
    return c.json({
      subproject_slug: slug,
      runs,
      total,
      limit,
      offset,
      stats: summarizeSubprojectRuns(runs),
    });
  },
);

// ── POST /:projectId/subprojects/author-session ──────────────────────────────────
//
// No ordering hazard here, unlike `subprojects/runs`: `author-session` is a
// two-segment path (`subprojects/author-session`) and every `{slug}` route has three
// (`subprojects/{slug}/runs`), so no pattern can capture it. `subprojects/runs` needed the
// explicit ordering because `subprojects/{slug}` would have matched it at the same
// depth.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/subprojects/author-session',
    tags: ['subprojects'],
    summary: 'POST /:projectId/subprojects/author-session — build a new subproject',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Authoring session started'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'subprojects');
    if (gate) return gate;
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_WRITE,
    );

    const body = await readBody(c);
    const description = typeof body?.description === 'string' ? body.description.trim() : '';
    if (!description) return c.json({ error: 'description is required' }, 400);
    // Bounded because it lands verbatim in a prompt. 4000 chars is far more
    // than a subproject description needs and far less than a context problem.
    if (description.length > 4000) {
      return c.json({ error: 'description must be 4000 characters or fewer' }, 400);
    }

    const result = await createSession({
      source: 'ui',
      project: loaded.row,
      userId: loaded.userId,
      requestingPrincipalType:
        c.get('authType') === 'service_account' ? 'service_account' : 'human',
      body: {
        initial_prompt: buildSubprojectAuthorPrompt({
          description,
          projectName: loaded.row.name,
        }),
        // The description, not "New subproject": the session list is how someone
        // finds this again, and five sessions all called "New subproject" is how it
        // becomes unfindable. Trimmed to a title length; the titling hook
        // replaces it with a real one once the session has a turn.
        name: `Subproject: ${description.slice(0, 60)}${description.length > 60 ? '…' : ''}`,
        // No `subproject_slug`: the subproject does not exist yet, so there is nothing to
        // attribute. `kind` is NOT in SERVER_MANAGED_SESSION_METADATA_KEYS and
        // does not need to be — nothing authorizes on it. Run attribution goes
        // through `project_trigger_runtime.subproject_slug`, which is materialized
        // from the committed manifest and unreachable from a session's own
        // metadata; the four `subproject_*` keys are the guarded ones.
        metadata: { kind: 'subproject-author' },
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

// ── PATCH /:projectId/subprojects/:slug/activation ───────────────────────────────
//
// Turn one subproject's triggers on or off. NOT `setProjectTriggersActivation`: that
// is the project-wide pause kill switch, and a subproject owns a subset. This writes
// the manifest — a subproject's activation is part of the project's committed
// configuration, so it survives a redeploy and shows up in `git log` like every
// other config change.
//
// A subproject installs with every trigger `enabled: false` (see
// `buildSubprojectInstallPrompt`), so this is the route that actually starts a
// subproject working.

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/subprojects/{slug}/activation',
    tags: ['subprojects'],
    summary: "PATCH /:projectId/subprojects/:slug/activation — enable a subproject's triggers",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'OK'),
      ...errors(400, 401, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'subprojects');
    if (gate) return gate;
    // `project.trigger.update`, not `project.write`: this changes whether
    // triggers fire, which is exactly what that leaf governs. The per-trigger
    // PATCH asserts the same one.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
    );

    const body = await readBody(c);
    if (typeof body?.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    const enabled = body.enabled as boolean;

    let changed: string[] = [];
    let installedTitle = slug;
    const result = await mutateManifestWithRetry(
      loaded.row,
      `subproject ${slug} was being updated`,
      (manifest) => {
        const installed = extractSubprojects(manifest).specs.find((entry) => entry.slug === slug);
        if (!installed) {
          return {
            ok: false,
            error: `No subproject "${slug}" is installed in this project`,
            status: 404,
          };
        }
        installedTitle = installed.title;
        const applied = setSubprojectTriggersEnabled(manifest, slug, enabled);
        changed = applied.changed;
        if (changed.length === 0) {
          // Already in the requested state. `commitMessage: null` skips git
          // entirely rather than landing an empty commit.
          return { ok: true, commitMessage: null };
        }
        manifest.raw = applied.manifest.raw;
        return {
          ok: true,
          commitMessage: `chore: ${enabled ? 'enable' : 'disable'} ${slug} subproject triggers`,
        };
      },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 502);
    }

    // The manifest is truth; the runtime catalog is the projection the cron
    // sweep reads. Re-materialize it now so an enable takes effect on the next
    // sweep rather than waiting for the leader's periodic reconcile.
    const project = await loadGitProject(loaded);
    const manifest = await readManifest(project).catch(() => null);
    if (manifest) {
      const triggers = extractTriggers(manifest);
      await reconcileProjectTriggerRuntime(projectId, triggers.specs).catch((err) =>
        console.warn('[subprojects] trigger runtime reconcile failed', projectId, slug, err),
      );
    }

    return c.json({
      ok: true,
      subproject_slug: slug,
      title: installedTitle,
      enabled,
      // Which triggers actually moved — an empty array means it was already in
      // this state, which is a different answer from "it worked".
      triggers: changed,
    });
  },
);
