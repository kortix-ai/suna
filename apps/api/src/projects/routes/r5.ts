import { config } from '../../config';
import { getProvider as getDeploymentProvider } from '../../deployments/providers';
import { auth, errors, json } from '../../openapi';
import { getWarmPoolCounts, refillProjectPool, resolveWarmConfig, warmPoolEnabled } from '../../platform/services/warm-pool';
import { db } from '../../shared/db';
import { deployAppSpec, getLatestDeployment } from '../app-sweep';
import { loadProjectApps, manifestHashForApp } from '../apps';
import { archiveRepoSubtree, getBranchDiff, getCommit, getCommitDiff, getFileHistory, grepRepoFiles, listBranches, listCommits, listRepoFiles, loadProjectConfig, readRepoFile, searchRepoFileNames } from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { deployments, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, CommitSchema, ProjectSchema, projectsApp } from '../lib/app';
import { getProjectGitConnection, withProjectGitAuth } from '../lib/git';
import { normalizeString, readBody, serializeDeploymentRow, serializeProject, serializeProjectGitConnection } from '../lib/serializers';

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/apps/{slug}/deploy',
    tags: ['apps'],
    summary: 'POST /:projectId/apps/:slug/deploy',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const { specs } = await loadProjectApps(await withProjectGitAuth(loaded.row));
  const spec = specs.find((s) => s.slug === slug);
  if (!spec) return c.json({ error: 'Not found' }, 404);

  const latest = await getLatestDeployment(projectId, slug);
  const status = await deployAppSpec({
    project: loaded.row,
    spec,
    previousVersion: latest?.version ?? 0,
    manifestHash: manifestHashForApp(spec),
    source: 'manual',
  });

  const fresh = await getLatestDeployment(projectId, slug);
  return c.json(
    {
      status,
      app_slug: slug,
      deployment: fresh ? serializeDeploymentRow(fresh) : null,
    },
    status === 'active' ? 201 : 502,
  );
},
);

// POST /v1/projects/:projectId/apps/:slug/stop — tear down the latest
// deployment on the provider. Marks the row 'stopped' locally even if
// the provider call fails (best-effort).

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/apps/{slug}/stop',
    tags: ['apps'],
    summary: 'POST /:projectId/apps/:slug/stop',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const latest = await getLatestDeployment(projectId, slug);
  if (!latest) return c.json({ error: 'No deployment found for this app' }, 404);

  const provider = getDeploymentProvider(latest.provider ?? undefined);
  if (latest.freestyleId) {
    try {
      await provider.stop(latest.freestyleId);
    } catch {
      // Best-effort — mark as stopped locally regardless.
    }
  }

  const [updated] = await db
    .update(deployments)
    .set({ status: 'stopped', updatedAt: new Date() })
    .where(eq(deployments.deploymentId, latest.deploymentId))
    .returning();

  return c.json({ ok: true, deployment: updated ? serializeDeploymentRow(updated) : null });
},
);

// GET /v1/projects/:projectId/apps/:slug/logs — provider logs for the
// latest deployment.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/apps/{slug}/logs',
    tags: ['apps'],
    summary: 'GET /:projectId/apps/:slug/logs',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), slug: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const slug = c.req.param('slug');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const latest = await getLatestDeployment(projectId, slug);
  if (!latest) return c.json({ error: 'No deployment found for this app' }, 404);

  const provider = getDeploymentProvider(latest.provider ?? undefined);
  try {
    const data = await provider.logs(latest.freestyleId ?? '');
    return c.json({ ok: true, data });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'logs unavailable' }, 502);
  }
},
);

// GET /v1/projects/:projectId

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}',
    tags: ['projects'],
    summary: 'GET /:projectId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(ProjectSchema, 'The project'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  await db
    .update(projects)
    .set({ lastOpenedAt: new Date(), updatedAt: new Date() })
    .where(eq(projects.projectId, projectId));

  return c.json(serializeProject(loaded.row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// GET /v1/projects/:projectId/detail

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/detail',
    tags: ['projects'],
    summary: 'GET /:projectId/detail',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(ProjectSchema, 'Project detail'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const gitProject = await withProjectGitAuth(loaded.row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitProject, loaded.row.defaultBranch);
  } catch (error) {
    console.warn('[projects] repo detail listing unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
  }
  const config = await loadProjectConfig(gitProject, files);
  return c.json({
    project: serializeProject(loaded.row, {
      projectRole: loaded.projectRole,
      effectiveRole: loaded.effectiveRole,
    }),
    git_connection: serializeProjectGitConnection(await getProjectGitConnection(projectId)),
    config,
    file_count: files.length,
    files: files.slice(0, 300),
  });
},
);

// GET /v1/projects/:projectId/files

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/files',
    tags: ['files'],
    summary: 'GET /:projectId/files',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
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

  const gitProject = await withProjectGitAuth(loaded.row);
  let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
  try {
    files = await listRepoFiles(gitProject, c.req.query('ref') || loaded.row.defaultBranch, c.req.query('path'));
  } catch (error) {
    console.warn('[projects] repo file listing unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
  }
  return c.json(files.slice(0, 1000));
},
);

// GET /v1/projects/:projectId/files/archive?path=...&ref=...
// Streams a zip archive of the repo (or a subtree) at the given ref.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/files/archive',
    tags: ['files'],
    summary: 'GET /:projectId/files/archive',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: { description: 'Binary archive', content: { 'application/octet-stream': { schema: z.any() } } },
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const path = normalizeString(c.req.query('path'));
  const ref = c.req.query('ref') || loaded.row.defaultBranch;

  try {
    const stream = await archiveRepoSubtree(await withProjectGitAuth(loaded.row), ref, path);
    const fileName = (path?.split('/').filter(Boolean).pop() || 'workspace') + '.zip';
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName.replace(/"/g, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to archive directory';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/projects/:projectId/files/content?path=...

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/files/search',
    tags: ['files'],
    summary: 'GET /:projectId/files/search',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const query = normalizeString(c.req.query('q'));
  if (!query) return c.json({ error: 'q query param is required' }, 400);

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const contentSearch = c.req.query('content') === '1';
  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);

  try {
    const gitProject = await withProjectGitAuth(loaded.row);
    if (contentSearch) {
      const matches = await grepRepoFiles(gitProject, query, ref, limit);
      return c.json({ query, ref, content_search: true, results: matches });
    }
    const files = await searchRepoFileNames(gitProject, query, ref, limit);
    return c.json({
      query,
      ref,
      content_search: false,
      results: files.map((f) => ({ path: f.path })),
    });
  } catch (error) {
    console.warn('[projects] file search unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ query, ref, content_search: contentSearch, results: [] });
  }
},
);


projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/files/content',
    tags: ['files'],
    summary: 'GET /:projectId/files/content',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: { description: 'OK', content: { 'application/octet-stream': { schema: z.any() } } },
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const path = normalizeString(c.req.query('path'));
  if (!path) return c.json({ error: 'path query param is required' }, 400);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const content = await readRepoFile(await withProjectGitAuth(loaded.row), path, ref);
  return c.json({ path, ref, content });
},
);

// GET /v1/projects/:projectId/files/history?path=...&ref=...&limit=...&skip=...

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/files/history',
    tags: ['files'],
    summary: 'GET /:projectId/files/history',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const path = normalizeString(c.req.query('path'));
  if (!path) return c.json({ error: 'path query param is required' }, 400);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const limit = Number(c.req.query('limit') || '50');
  const skip = Number(c.req.query('skip') || '0');
  try {
    const result = await getFileHistory(await withProjectGitAuth(loaded.row), path, { ref, limit, skip });
    return c.json({ path, ref, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load history';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/projects/:projectId/branches

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/branches',
    tags: ['files'],
    summary: 'GET /:projectId/branches',
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

  try {
    const branches = await listBranches(await withProjectGitAuth(loaded.row));
    return c.json({
      default_branch: loaded.row.defaultBranch,
      branches,
    });
  } catch (error) {
    console.warn('[projects] branch listing unavailable', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    c.header('X-Kortix-Repo-Status', 'unavailable');
    return c.json({ default_branch: loaded.row.defaultBranch, branches: [] });
  }
},
);

// GET /v1/projects/:projectId/commits?ref=...&path=...&limit=...&skip=...

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/commits',
    tags: ['files'],
    summary: 'GET /:projectId/commits',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.array(CommitSchema), 'Commits'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  const path = normalizeString(c.req.query('path'));
  const limit = Number(c.req.query('limit') || '50');
  const skip = Number(c.req.query('skip') || '0');
  try {
    const result = await listCommits(await withProjectGitAuth(loaded.row), { ref, path, limit, skip });
    return c.json({ ref, path: path ?? null, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load commits';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/projects/:projectId/commits/:sha

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/commits/{sha}',
    tags: ['files'],
    summary: 'GET /:projectId/commits/:sha',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sha: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sha = c.req.param('sha');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    const commit = await getCommit(await withProjectGitAuth(loaded.row), sha);
    if (!commit) return c.json({ error: 'Commit not found' }, 404);
    return c.json(commit);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load commit';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/projects/:projectId/commits/:sha/diff?path=...

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/commits/{sha}/diff',
    tags: ['files'],
    summary: 'GET /:projectId/commits/:sha/diff',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), sha: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const sha = c.req.param('sha');
  const path = normalizeString(c.req.query('path'));
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  try {
    const diff = await getCommitDiff(await withProjectGitAuth(loaded.row), sha, { path });
    return c.json({ path: path ?? null, ...diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load diff';
    return c.json({ error: message }, 400);
  }
},
);

// GET /v1/projects/:projectId/version-diff?from=<ref>&into=<ref>
// Lightweight preview used by the "Open change request" dialog so the user
// can see whether there's anything to merge BEFORE creating the CR. Returns
// a summary (no patch body) so the dialog can show "X files changed, +Y -Z"
// live and gate the submit button.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/version-diff',
    tags: ['files'],
    summary: 'GET /:projectId/version-diff',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({}).passthrough(),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const fromRef = normalizeString(c.req.query('from') ?? c.req.query('head'));
  const intoRef = normalizeString(c.req.query('into') ?? c.req.query('base'));
  if (!fromRef || !intoRef) {
    return c.json({ error: 'from and into query params are required' }, 400);
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  if (fromRef === intoRef) {
    return c.json({
      from: fromRef,
      into: intoRef,
      from_sha: null,
      into_sha: null,
      merge_base: null,
      files_changed: 0,
      additions: 0,
      deletions: 0,
      is_up_to_date: true,
      is_same_ref: true,
    });
  }

  try {
    const diff = await getBranchDiff(await withProjectGitAuth(loaded.row), intoRef, fromRef);
    return c.json({
      from: fromRef,
      into: intoRef,
      from_sha: diff.head_sha,
      into_sha: diff.base_sha,
      merge_base: diff.merge_base,
      files_changed: diff.files_changed,
      additions: diff.additions,
      deletions: diff.deletions,
      is_up_to_date: diff.head_sha === diff.base_sha,
      is_same_ref: false,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Failed to compute diff preview',
    }, 400);
  }
},
);

// PATCH /v1/projects/:projectId

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}',
    tags: ['projects'],
    summary: 'PATCH /:projectId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(ProjectSchema, 'The updated project'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  const name = normalizeString(body.name);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch);
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath);

  if (name) updates.name = name;
  if (defaultBranch) updates.defaultBranch = defaultBranch;
  if (manifestPath) updates.manifestPath = manifestPath;

  const [row] = await db
    .update(projects)
    .set(updates)
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// GET /v1/projects/:projectId/warm-pool
// Live warm pool config + status for the Customize → Sandbox card: how many
// sandboxes are ready (parked) vs warming (booting) right now.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/warm-pool',
    tags: ['projects'],
    summary: 'GET /:projectId/warm-pool',
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
  const cfg = resolveWarmConfig(loaded.row.metadata);
  const counts = warmPoolEnabled() ? await getWarmPoolCounts(projectId) : { ready: 0, warming: 0 };
  return c.json({ available: warmPoolEnabled(), enabled: cfg.enabled, size: cfg.size, ...counts });
},
);

// PATCH /v1/projects/:projectId/warm-pool
// Per-project warm pool config (Customize → Sandbox). DB-only — stored in
// projects.metadata.warm_pool, never in kortix.toml. Applies immediately by
// kicking a refill toward the new desired size.

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/warm-pool',
    tags: ['projects'],
    summary: 'PATCH /:projectId/warm-pool',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const meta = (loaded.row.metadata ?? {}) as Record<string, unknown>;
  const prev = (meta.warm_pool && typeof meta.warm_pool === 'object' && !Array.isArray(meta.warm_pool)
    ? meta.warm_pool
    : {}) as Record<string, unknown>;
  const enabled =
    typeof body.enabled === 'boolean' ? body.enabled : typeof prev.enabled === 'boolean' ? prev.enabled : true;
  let size =
    body.size !== undefined && Number.isFinite(Number(body.size))
      ? Math.floor(Number(body.size))
      : typeof prev.size === 'number'
        ? prev.size
        : config.KORTIX_WARM_POOL_SIZE;
  if (size < 0) size = 0;
  if (size > 25) size = 25;
  const warm_pool = { enabled, size };

  const [row] = await db
    .update(projects)
    .set({ metadata: { ...meta, warm_pool }, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  void refillProjectPool(projectId).catch(() => {});
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
},
);

// PATCH /v1/projects/:projectId/apps-config
// Per-project toggle for the experimental [[apps]] deployment surface
// (Customize → Settings). DB-only — stored in projects.metadata.apps_enabled,
// never in kortix.toml. Overrides the operator default KORTIX_APPS_EXPERIMENTAL.
// `enabled: null` clears the override and falls back to the operator default.

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/apps-config',
    tags: ['apps'],
    summary: 'PATCH /:projectId/apps-config',
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
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const meta = (loaded.row.metadata ?? {}) as Record<string, unknown>;
  const nextMeta: Record<string, unknown> = { ...meta };
  if (body.enabled === null) {
    delete nextMeta.apps_enabled;
  } else if (typeof body.enabled === 'boolean') {
    nextMeta.apps_enabled = body.enabled;
  } else {
    return c.json({ error: 'enabled must be a boolean or null' }, 400);
  }

  const [row] = await db
    .update(projects)
    .set({ metadata: nextMeta, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();
  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
},
);

// PATCH /v1/projects/:projectId/onboarding
// Persist whether the project's guided onboarding wizard has been completed
// (or explicitly skipped). Stored in `metadata.onboarding_completed_at` so we
// avoid a schema migration — the projects.metadata jsonb already exists and
// is already exposed by serializeProject. Project-wide state (not per-user).
