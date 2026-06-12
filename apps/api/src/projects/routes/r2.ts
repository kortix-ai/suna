import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { DEFAULT_SANDBOX_SLUG, deleteSandboxImage, kickPreBuild, kickProjectTemplatePrebuilds, listSandboxTemplates, listSnapshotBuilds, reconcileStaleBuilds } from '../../snapshots/builder';
import { classifySnapshotError, describeSnapshotError } from '../../snapshots/error-classify';
import { getSandboxProvider } from '../../snapshots/providers';
import { withTimeout } from '../../shared/with-timeout';
import { createTemplate, deleteTemplate, getTemplateById, updateTemplate } from '../../snapshots/templates';
import { commitFile, createRepo, getFileSha } from '../github';
import { buildStarterFiles, normalizeStarterTemplateId } from '../starter';
import { createRoute, z } from '@hono/zod-openapi';
import { enforceProjectQuota, loadProjectForUser, resolveProjectAccount } from '../lib/access';
import { AnyObject, SandboxTemplateSchema, SnapshotSchema, projectsApp } from '../lib/app';
import { GitHubInstallationRequiredError, createGitHubInstallationInstallUrl, getProjectGitConnection, loadGitProject, registerGitHubLinkedProject, registerPatLinkedProject, resolveGitHubImport, resolveGitHubImportWithPat, resolveGitHubRepoAuth } from '../lib/git';
import { deriveProjectName, isRepoNameTakenError, normalizeString, readBody, requestAuditContext, serializeBuildSummary, serializeProject, serializeProjectGitConnection, serializeTemplate } from '../lib/serializers';
import { createProjectSession, sendSessionCreateError } from '../lib/sessions';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/link-repository',
    tags: ['github'],
    summary: 'POST /link-repository',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(400, 409),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const repoFullName = normalizeString(body.repo_full_name ?? body.repoFullName);
  const repoUrlInput = normalizeString(body.repo_url ?? body.repoUrl);
  const repoUrl = repoFullName
    ? `https://github.com/${repoFullName.replace(/\.git$/i, '')}.git`
    : repoUrlInput;
  if (!repoUrl) return c.json({ error: 'repo_url or repo_full_name is required' }, 400);

  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath) ?? 'kortix.toml';

  // PAT path: link an existing repo with a caller-supplied token — no GitHub
  // App install needed. This is the seamless `kortix ship` flow for a repo you
  // already own (and the App-free fallback in environments where the App can't
  // be installed). Everything downstream (`resolveProjectGitAuth` →
  // `project_credential`) already consumes the stored PAT.
  const githubToken = normalizeString(body.github_token ?? body.githubToken);
  if (githubToken) {
    let patImport: Awaited<ReturnType<typeof resolveGitHubImportWithPat>>;
    try {
      patImport = await resolveGitHubImportWithPat({
        repoUrl,
        token: githubToken,
        defaultBranch: normalizeString(body.default_branch ?? body.defaultBranch),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
    }
    const patQuota = await enforceProjectQuota(c, scope.accountId, { repoUrl: patImport.repo.clone_url });
    if (patQuota) return patQuota;
    const row = await registerPatLinkedProject({
      accountId: scope.accountId,
      userId: scope.userId,
      repo: patImport.repo,
      token: githubToken,
      name: normalizeString(body.name),
      defaultBranch: patImport.defaultBranch,
      manifestPath,
    });
    kickProjectTemplatePrebuilds(
      { projectId: row.projectId, repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, manifestPath: row.manifestPath, gitAuthToken: githubToken },
      { accountId: scope.accountId, source: 'project-create' },
    );
    return c.json({
      project: serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
      git_connection: serializeProjectGitConnection(await getProjectGitConnection(row.projectId)),
    }, 201);
  }

  let imported: Awaited<ReturnType<typeof resolveGitHubImport>>;
  try {
    imported = await resolveGitHubImport({
      accountId: scope.accountId,
      repoUrl,
      installationId: normalizeString(body.installation_id ?? body.installationId),
      defaultBranch: normalizeString(body.default_branch ?? body.defaultBranch),
    });
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    return c.json({ error: (error as Error).message || 'Failed to validate GitHub repository' }, 400);
  }

  const linkQuota = await enforceProjectQuota(c, scope.accountId, { repoUrl: imported.repo.clone_url });
  if (linkQuota) return linkQuota;

  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo: imported.repo,
    installation: imported.installation,
    name: normalizeString(body.name),
    defaultBranch: imported.defaultBranch,
    manifestPath,
  });

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: imported.auth.token,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );

  return c.json({
    project: serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }),
    git_connection: serializeProjectGitConnection(await getProjectGitConnection(row.projectId)),
  }, 201);
},
);

// POST /v1/projects/create-repo
// Creates a new GitHub repository using the account's GitHub App installation,
// then registers it as a Kortix project.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/create-repo',
    tags: ['github'],
    summary: 'POST /create-repo',
    ...auth,
      request: {
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(400, 409, 502, 503),
    },
  }),
  async (c: any) => {
  const body = await readBody(c);
  const scope = await resolveProjectAccount(c, body);
  await assertAuthorized(scope.userId, scope.accountId, ACCOUNT_ACTIONS.PROJECT_CREATE);

  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.json({ error: 'name must contain only letters, numbers, hyphens, underscores or dots' }, 400);
  }

  const isPrivate = typeof body.private === 'boolean' ? body.private : true;
  const description = normalizeString(body.description);

  let githubAuth: Awaited<ReturnType<typeof resolveGitHubRepoAuth>>;
  try {
    githubAuth = await resolveGitHubRepoAuth(scope.accountId, normalizeString(body.installation_id ?? body.installationId));
  } catch (error) {
    if (error instanceof GitHubInstallationRequiredError) {
      return c.json({
        error: error.message,
        install_url: await createGitHubInstallationInstallUrl(error.accountId, scope.userId),
      }, 409);
    }
    const message = (error as Error).message || 'GitHub is not configured on the server';
    return c.json({ error: message }, 503);
  }
  if (!githubAuth.installation || !githubAuth.auth) {
    return c.json({
      error: 'Install the Kortix GitHub App before creating GitHub-backed projects',
      install_url: await createGitHubInstallationInstallUrl(scope.accountId, scope.userId),
    }, 409);
  }

  // create-repo always provisions a fresh GitHub repo, so block before we
  // create anything upstream — a straight count, no idempotent re-link.
  const createRepoQuota = await enforceProjectQuota(c, scope.accountId);
  if (createRepoQuota) return createRepoQuota;

  // Auto-dedupe name collisions: GitHub 422s when the repo name is taken, so
  // try "name", then "name-2", "name-3", … until one is free (up to 12 tries).
  let repo: Awaited<ReturnType<typeof createRepo>> | undefined;
  let lastRepoError: unknown = null;
  for (let attempt = 0; attempt < 12 && !repo; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name}-${attempt + 1}`;
    try {
      repo = await createRepo({
        name: candidate,
        isPrivate,
        description: description ?? undefined,
        autoInit: true,
        auth: githubAuth.auth,
      });
    } catch (error) {
      lastRepoError = error;
      if (isRepoNameTakenError(error)) continue; // name taken — try the next suffix
      return c.json({ error: (error as Error).message || 'Failed to create GitHub repository' }, 502);
    }
  }
  if (!repo) {
    return c.json(
      {
        error:
          `Could not find an available repository name near "${name}" — too many already exist. ` +
          `Pick a different name. ${(lastRepoError as Error)?.message ?? ''}`.trim(),
      },
      409,
    );
  }

  const projectName = normalizeString(body.project_name ?? body.projectName) ?? deriveProjectName(repo.full_name);
  const defaultBranch = repo.default_branch || 'main';

  // Commit the Kortix starter into the fresh repo so users land with a
  // working project shape on first session boot. GitHub's Contents API
  // updates the branch tip on every write, so these must be sequential.
  // A partial starter is not a usable project.
  const [ownerLogin, repoSlug] = repo.full_name.split('/');
  const starterTemplate = normalizeStarterTemplateId(body.starter_template ?? body.starterTemplate);
  const starter = buildStarterFiles({
    projectName,
    repoFullName: repo.full_name,
    template: starterTemplate,
  });
  for (const file of starter) {
    try {
      // README.md exists already from `auto_init: true` — upsert via sha.
      const existingSha = file.path === 'README.md'
        ? await getFileSha({ owner: ownerLogin, repo: repoSlug, path: file.path, branch: defaultBranch, auth: githubAuth.auth })
        : null;
      await commitFile({
        owner: ownerLogin,
        repo: repoSlug,
        path: file.path,
        content: file.content,
        message: `chore: scaffold ${file.path}`,
        branch: defaultBranch,
        existingSha: existingSha ?? undefined,
        auth: githubAuth.auth,
      });
    } catch (err) {
      const message = (err as Error).message || 'Failed to scaffold starter file';
      console.warn(`[projects/create-repo] Failed to scaffold ${file.path} into ${repo.full_name}:`, message);
      return c.json({ error: `Failed to scaffold starter file ${file.path}: ${message}` }, 502);
    }
  }

  const row = await registerGitHubLinkedProject({
    accountId: scope.accountId,
    userId: scope.userId,
    repo,
    installation: githubAuth.installation,
    name: projectName,
    defaultBranch,
    manifestPath: 'kortix.toml',
  });

  kickProjectTemplatePrebuilds(
    {
      projectId: row.projectId,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      manifestPath: row.manifestPath,
      gitAuthToken: githubAuth.auth?.token ?? null,
    },
    { accountId: scope.accountId, source: 'project-create' },
  );


  return c.json(serializeProject(row, { projectRole: 'manager', effectiveRole: 'manager' }), 201);
},
);

// ─── Manifest validation ──────────────────────────────────────────────────
// One schema, exercised in three places: the CLI (`kortix ship` pre-flight +
// `kortix validate`), this server-side endpoint (lets dashboards / tooling
// ask the server "is this valid?"), and the CR-merge gate.
//
// Body: { raw: string } (TOML text). Always returns 200 — the verdict is in
// the body so the caller can show issues without having to handle HTTP error
// codes. CLI use: `kortix validate` runs locally, this is for surfaces that
// don't have the file on disk.

// POST /v1/projects/:projectId/manifest/validate

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/manifest/validate',
    tags: ['projects'],
    summary: 'POST /:projectId/manifest/validate',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: { raw?: unknown } = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }
  const raw = typeof body.raw === 'string' ? body.raw : null;
  if (!raw) {
    return c.json({ error: 'Missing `raw` (TOML string) in body.' }, 400);
  }

  const { validateManifest } = await import('@kortix/manifest-schema');
  const verdict = validateManifest(raw);
  return c.json({
    valid: verdict.valid,
    issues: verdict.issues,
  });
},
);

// ─── Sandbox templates ─────────────────────────────────────────────────────
// One platform-default image, optionally extended by `[[sandbox.templates]]` entries
// in kortix.toml. Session boot is stateless: it computes the expected snapshot
// name from the resolved template, asks Daytona if it exists, builds if not.
// The append-only `project_snapshot_builds` log feeds the UI but is never
// consulted by the boot path.


projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandboxes',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/sandboxes',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 500),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  try {
    const templates = await listSandboxTemplates(project);
    return c.json({
      items: templates.map(serializeTemplate),
      default_slug: templates.find((t) => t.isDefault)?.slug ?? templates[0]?.slug ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to list sandbox templates: ${message}` }, 500);
  }
},
);

// GET /v1/projects/:projectId/snapshots
// Templates + recent build log. Used by the Sandbox panel.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/snapshots',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/snapshots',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(SnapshotSchema), 'Snapshots'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  let templates: Awaited<ReturnType<typeof listSandboxTemplates>> = [];
  let templatesError: string | null = null;
  try {
    templates = await listSandboxTemplates(project);
  } catch (err) {
    templatesError = err instanceof Error ? err.message : String(err);
  }
  // Heal any build rows orphaned at "building" by a process restart/crash
  // before reading them, so the dashboard never shows a permanent "Building".
  await reconcileStaleBuilds({ projectId }).catch(() => {});
  const builds = await listSnapshotBuilds(projectId, { limit: 25 }).catch(() => []);
  return c.json({
    templates: templates.map(serializeTemplate),
    templates_error: templatesError,
    builds: builds.map(serializeBuildSummary),
  });
},
);

// GET /v1/projects/:projectId/sandbox-health
// Cheap polling endpoint for the sidebar alert. Surfaces the platform default
// template's live state + the most recent failed build (across any template).
//
// Whole-handler wall-clock budget, kept comfortably under the frontend's 30s
// request timeout (apps/web/src/lib/api-client.ts → "Request timed out after
// 30s"). EVERY dependency this poll touches — git-auth resolution, the
// (Daytona-bound) templates lookup, AND the build-log DB query — can degrade
// independently, so bounding only the templates fetch still let a slow DB or
// git-auth call hang the request to the client's 30s abort. A single budget
// over the whole body guarantees the poll always answers fast: a degraded
// dependency renders the alert as "unknown / no templates" instead of paging
// us with the timeout error.
const SANDBOX_HEALTH_BUDGET_MS = 12_000;

interface SandboxHealthPayload {
  primary_slug: string | null;
  primary_template: ReturnType<typeof serializeTemplate> | null;
  ready: boolean;
  building: boolean;
  latest_build: ReturnType<typeof serializeBuildSummary> | null;
  latest_failure: ReturnType<typeof serializeBuildSummary> | null;
}

// Safe degraded payload: same shape as the happy path, surfaced when any
// dependency is too slow. "Unknown" rather than a hard error so the sidebar
// alert simply shows nothing and the next poll re-checks once we recover.
const SANDBOX_HEALTH_DEGRADED: SandboxHealthPayload = {
  primary_slug: null,
  primary_template: null,
  ready: false,
  building: false,
  latest_build: null,
  latest_failure: null,
};

async function buildSandboxHealth(
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>,
  projectId: string,
): Promise<SandboxHealthPayload> {
  const project = await loadGitProject(loaded);
  let templates: Awaited<ReturnType<typeof listSandboxTemplates>> = [];
  try {
    // Repo unreachable / manifest broken / Daytona slow — render as "no
    // templates" rather than failing the whole poll. (Each Daytona state
    // lookup is also individually bounded in the provider.)
    templates = await listSandboxTemplates(project);
  } catch {
    /* no templates */
  }
  const primary = templates[0] ?? null;
  const builds = await listSnapshotBuilds(projectId, { limit: 10 }).catch(() => []);
  const latest = builds[0] ?? null;
  const latestFailure = builds.find((b) => b.status === 'failed') ?? null;
  const isBuilding =
    (latest && latest.status === 'building') ||
    (primary ? ['pulling', 'building'].includes(primary.daytonaState.toLowerCase()) : false);

  return {
    primary_slug: primary?.slug ?? null,
    primary_template: primary ? serializeTemplate(primary) : null,
    ready: primary?.ready ?? false,
    building: isBuilding,
    latest_build: latest ? serializeBuildSummary(latest) : null,
    latest_failure: latestFailure ? serializeBuildSummary(latestFailure) : null,
  };
}

// Exported for unit coverage of the wall-clock degradation contract.
export { SANDBOX_HEALTH_BUDGET_MS, SANDBOX_HEALTH_DEGRADED, buildSandboxHealth };

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandbox-health',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/sandbox-health',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let payload: SandboxHealthPayload = SANDBOX_HEALTH_DEGRADED;
  try {
    payload = await withTimeout(
      buildSandboxHealth(loaded, projectId),
      SANDBOX_HEALTH_BUDGET_MS,
      'sandbox-health',
    );
  } catch {
    // Any dependency (git-auth / templates / build-log DB) too slow or
    // failing — degrade to "unknown" rather than hang to the client's 30s
    // abort. The losing work settles in the background; the next poll retries.
  }

  return c.json(payload);
},
);

// POST /v1/projects/:projectId/snapshots/rebuild
// Force-rebuild the image for a given template slug (defaults to the platform
// default). Deletes the existing Daytona snapshot (if any) so the next
// ensureSandboxImage rebuilds from scratch. Returns 202.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/snapshots/rebuild',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/snapshots/rebuild',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        202: json(z.any(), 'OK'),
        ...errors(404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: { slug?: unknown; sandbox_slug?: unknown } = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    /* empty body is fine */
  }
  const slugRaw = (typeof body.slug === 'string' && body.slug)
    || (typeof body.sandbox_slug === 'string' && body.sandbox_slug)
    || undefined;
  const slug = slugRaw ? String(slugRaw).trim() : undefined;

  const project = await loadGitProject(loaded);
  try {
    const deleted = await deleteSandboxImage(project, { slug });
    kickPreBuild(project, {
      slug: deleted.slug,
      accountId: loaded.row.accountId,
      source: 'manual',
    });
    return c.json(
      {
        status: 'started',
        slug: deleted.slug,
        deleted_existing: deleted.deleted,
        snapshot_name: deleted.snapshotName,
      },
      202,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
},
);

// POST /v1/projects/:projectId/snapshots/fix-with-agent
// Spin up a session pre-seeded with the most recent build failure so an agent
// can diagnose + fix the Dockerfile and open a change request. Requires a
// previous successful build to host the fix session.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/snapshots/fix-with-agent',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/snapshots/fix-with-agent',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        201: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const userId = c.get('userId') as string;

  const builds = await listSnapshotBuilds(projectId, { limit: 50 }).catch(() => []);
  const failed = builds.find((b) => b.status === 'failed');
  if (!failed) {
    return c.json({ error: 'No failed snapshot build to fix.' }, 409);
  }

  const hostBuild = builds.find((b) => b.status === 'ready');
  if (!hostBuild) {
    return c.json(
      {
        error:
          'No ready sandbox to run the fix in yet. Retry the build, or edit the Dockerfile manually.',
        code: 'NO_READY_SANDBOX',
      },
      409,
    );
  }

  const errorText = failed.error ?? 'Snapshot build failed';
  const category = failed.errorCategory ?? classifySnapshotError(errorText);
  const info = describeSnapshotError(category as ReturnType<typeof classifySnapshotError>);

  const prompt = [
    `The sandbox image build for the "${failed.slug}" template is failing, so new sessions on it can't boot. Diagnose and fix the root cause, then open a change request.`,
    ``,
    `Failing template: ${failed.slug}`,
    `Error type: ${category} — ${info.title}`,
    info.hint,
    ``,
    `Build error:`,
    '```',
    errorText.slice(0, 4000),
    '```',
    ``,
    `The sandbox image is built from the template definition (see [[sandbox.templates]] in kortix.toml).`,
    ``,
    `Steps:`,
    `1. Inspect the relevant Dockerfile and the build error above.`,
    `2. Fix the root cause.`,
    `3. Open a change request. Once it merges, the image rebuilds automatically.`,
  ].join('\n');

  const result = await createProjectSession({
    project: loaded.row,
    userId,
    body: {
      initial_prompt: prompt,
      name: 'Fix sandbox build',
      metadata: { kind: 'sandbox-build-fix', failed_slug: failed.slug },
      sandbox_slug: hostBuild.slug,
    },
    request: requestAuditContext(c),
  });
  if (result.error) return sendSessionCreateError(c, result.error);

  return c.json({ session_id: result.row!.sessionId }, 201);
},
);

// ─── Template CRUD ─────────────────────────────────────────────────────────
// Full CRUD over `kortix.sandbox_templates`. Shared/platform rows are read-
// only. Project-scoped rows can be created/edited/deleted from the dashboard.

// GET /v1/projects/:projectId/sandbox-templates — same as /sandboxes; thinner
// path for the "templates only" UI surface. We re-use the same serializer.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandbox-templates',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/sandbox-templates',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(SandboxTemplateSchema), 'Sandbox templates'),
        ...errors(404, 500),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const project = await loadGitProject(loaded);
  try {
    const templates = await listSandboxTemplates(project);
    return c.json({
      items: templates.map(serializeTemplate),
      default_slug: templates.find((t) => t.isDefault)?.slug ?? templates[0]?.slug ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to list templates: ${message}` }, 500);
  }
},
);

// POST /v1/projects/:projectId/sandbox-templates — create a custom template.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sandbox-templates',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/sandbox-templates',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(SandboxTemplateSchema, 'The created sandbox template'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!slug || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    return c.json({ error: 'slug must be lowercase letters/digits/_- (1-64 chars)' }, 400);
  }
  if (slug === DEFAULT_SANDBOX_SLUG) {
    return c.json({ error: 'slug "default" is reserved for the platform template' }, 409);
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : slug;
  const image = typeof body.image === 'string' && body.image.trim() ? body.image.trim() : undefined;
  const dockerfilePath = typeof body.dockerfile_path === 'string' && body.dockerfile_path.trim()
    ? body.dockerfile_path.trim()
    : undefined;
  if ((image && dockerfilePath) || (!image && !dockerfilePath)) {
    return c.json({ error: 'Provide exactly one of `image` or `dockerfile_path`.' }, 400);
  }
  const entrypoint = typeof body.entrypoint === 'string' && body.entrypoint.trim()
    ? body.entrypoint.trim()
    : undefined;
  const cpu = typeof body.cpu === 'number' ? body.cpu : undefined;
  const memoryGb = typeof body.memory_gb === 'number' ? body.memory_gb : undefined;
  const diskGb = typeof body.disk_gb === 'number' ? body.disk_gb : undefined;

  try {
    const row = await createTemplate({
      projectId,
      accountId: loaded.row.accountId,
      slug,
      name,
      image,
      dockerfilePath,
      entrypoint,
      cpu,
      memoryGb,
      diskGb,
      source: 'ui',
    });
    // Kick a build in the background so the template is ready for the next session.
    const project = await loadGitProject(loaded);
    kickPreBuild(project, { slug: row.slug, accountId: loaded.row.accountId, source: 'manual' });
    return c.json({ template_id: row.templateId, slug: row.slug }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('duplicate') || message.includes('idx_sandbox_templates_project_slug')) {
      return c.json({ error: `A template with slug "${slug}" already exists.` }, 409);
    }
    return c.json({ error: message }, 400);
  }
},
);

// PATCH /v1/projects/:projectId/sandbox-templates/:templateId — update fields.

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sandbox-templates/{templateId}',
    tags: ['sandboxes'],
    summary: 'PATCH /:projectId/sandbox-templates/:templateId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), templateId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }

  const patch = {
    name: typeof body.name === 'string' ? body.name.trim() : undefined,
    image: 'image' in body ? (typeof body.image === 'string' ? body.image.trim() || null : null) : undefined,
    dockerfilePath: 'dockerfile_path' in body
      ? (typeof body.dockerfile_path === 'string' ? body.dockerfile_path.trim() || null : null)
      : undefined,
    entrypoint: 'entrypoint' in body
      ? (typeof body.entrypoint === 'string' ? body.entrypoint.trim() || null : null)
      : undefined,
    cpu: 'cpu' in body ? (typeof body.cpu === 'number' ? body.cpu : null) : undefined,
    memoryGb: 'memory_gb' in body ? (typeof body.memory_gb === 'number' ? body.memory_gb : null) : undefined,
    diskGb: 'disk_gb' in body ? (typeof body.disk_gb === 'number' ? body.disk_gb : null) : undefined,
  };

  try {
    const updated = await updateTemplate(templateId, patch);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    if (updated.projectId !== projectId) return c.json({ error: 'Not found' }, 404);
    return c.json({ template_id: updated.templateId, slug: updated.slug });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
},
);

// DELETE /v1/projects/:projectId/sandbox-templates/:templateId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sandbox-templates/{templateId}',
    tags: ['sandboxes'],
    summary: 'DELETE /:projectId/sandbox-templates/:templateId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), templateId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.projectId !== projectId) return c.json({ error: 'Not found' }, 404);
  if (row.isShared) return c.json({ error: 'Shared platform templates cannot be deleted.' }, 409);

  try {
    // Best-effort: clear the provider snapshot too.
    if (row.providerSnapshotName) {
      await getSandboxProvider(row.provider)
        .deleteSnapshot(row.providerSnapshotName)
        .catch(() => {});
    }
    await deleteTemplate(templateId);
    return c.body(null, 204);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
},
);

// POST /v1/projects/:projectId/sandbox-templates/:templateId/build — trigger
// a build (fire-and-forget). Returns 202.
