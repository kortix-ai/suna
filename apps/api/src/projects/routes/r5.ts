import { getProvider as getDeploymentProvider } from '../../deployments/providers';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { deployAppSpec, getLatestDeployment } from '../app-sweep';
import { loadProjectApps, manifestHashForApp } from '../apps';
import { archiveRepoSubtree, getBranchDiff, getCommit, getCommitDiff, getFileHistory, grepRepoFiles, listBranches, listCommits, listRepoFiles, loadProjectConfig, readRepoFile, searchRepoFileNames } from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { deployments, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import { filterConfigResourcesForUser, denierFromConfig, resourceDenierForRequest } from '../lib/project-resources';
import { assertAgentScope } from '../../iam/agent-scope';
import { AnyObject, CommitSchema, ProjectSchema, projectsApp } from '../lib/app';
import { getProjectGitConnection, withProjectGitAuth } from '../lib/git';
import { normalizeString, readBody, serializeDeploymentRow, serializeProject, serializeProjectGitConnection } from '../lib/serializers';

function isMissingGitPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^fatal: path '.+' does not exist in '.+'$/m.test(message);
}

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_DEPLOY);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_DEPLOY);

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
  const rawConfig = await loadProjectConfig(gitProject, files);
  // Per-resource scoping: hide agents/skills this member isn't granted (owner/
  // admins/SAs see everything). No-op when the project has no resource grants.
  const denierCtx = {
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    projectId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
  };
  const config = await filterConfigResourcesForUser(rawConfig, denierCtx);
  // …and hide the raw FILES of those resources from the file list (visibility
  // isolation). Reuses the config already loaded — no extra git round-trip.
  const denier = await denierFromConfig(rawConfig, denierCtx);
  const visibleFiles = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
  return c.json({
    project: serializeProject(loaded.row, {
      projectRole: loaded.projectRole,
      effectiveRole: loaded.effectiveRole,
    }),
    git_connection: serializeProjectGitConnection(await getProjectGitConnection(projectId)),
    config,
    file_count: visibleFiles.length,
    files: visibleFiles.slice(0, 300),
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
  // Visibility isolation: drop files of agents/skills this member is scoped out
  // of. No-op (one memo check) when the project scopes nothing.
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    projectId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  const visible = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
  return c.json(visible.slice(0, 1000));
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

  // Visibility isolation: a zip can't be stripped mid-stream, so refuse any
  // archive whose subtree would include an agent/skill this member is scoped out
  // of (e.g. the whole repo, or `.opencode/`). They can still archive a narrower
  // path that contains none. No-op when nothing is scoped.
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    projectId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  if (denier?.containsDenied(path ?? '')) {
    return c.json(
      { error: 'This folder includes agents or skills you are not allowed to access. Archive a more specific path instead.' },
      403,
    );
  }

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
    // Visibility isolation: never surface (path or content) a scoped-out
    // agent/skill in search results. One memo check when nothing is scoped.
    const denier = await resourceDenierForRequest({
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      projectId,
      actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
      row: loaded.row,
    });
    if (contentSearch) {
      const matches = await grepRepoFiles(gitProject, query, ref, limit);
      const results = denier ? matches.filter((m) => !denier.isDenied(m.path)) : matches;
      return c.json({ query, ref, content_search: true, results });
    }
    const files = await searchRepoFileNames(gitProject, query, ref, limit);
    const visible = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
    return c.json({
      query,
      ref,
      content_search: false,
      results: visible.map((f) => ({ path: f.path })),
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

  // Visibility isolation: a scoped-out member can't read the raw file of an
  // agent/skill they aren't granted — return the same 404 as a missing file so
  // the path isn't even confirmed to exist.
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    projectId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  if (denier?.isDenied(path)) return c.json({ error: 'File not found' }, 404);

  const ref = c.req.query('ref') || loaded.row.defaultBranch;
  try {
    const content = await readRepoFile(await withProjectGitAuth(loaded.row), path, ref);
    return c.json({ path, ref, content });
  } catch (error) {
    if (isMissingGitPathError(error)) {
      return c.json({ error: 'File not found' }, 404);
    }
    throw error;
  }
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
  // Editing project config (name / default_branch / manifest_path) is a
  // customize-write capability. manifest_path is especially sensitive: it
  // selects which kortix.toml drives per-agent env scoping, so a custom role
  // can withhold it and a scoped agent must hold it (central fold).
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

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
