/** A project's repository contents: files, archive, search, history, branches, commits, and diffs. */
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import {
  archiveRepoSubtree,
  getBranchDiff,
  getCommit,
  getCommitDiff,
  getFileHistory,
  grepRepoFiles,
  isRepoFileNotFoundError,
  listBranches,
  listCommits,
  listRepoFiles,
  readRepoFile,
  searchRepoFileNames,
} from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { resourceDenierForRequest } from '../lib/project-resources';
import { CommitSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { normalizeString } from '../lib/serializers';

function isMissingGitPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^fatal: path '.+' does not exist in '.+'$/m.test(message);
}

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_FILE_READ);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_FILE_READ);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_FILE_READ);

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
  // Absolute and traversal paths can never resolve inside the repo tree —
  // e.g. the platform meta agent's /workspace/AGENTS.md lives in the sandbox
  // image, not the project repo. Answer like any other missing file.
  if (path.startsWith('/') || path.includes('..')) {
    return c.json({ error: 'File not found' }, 404);
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_FILE_READ);

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
    // `readRepoFile` converts a `git show` "path does not exist" failure into a
    // typed `RepoFileNotFoundError` (message: `file not found in repository at
    // '<ref>:<path>'`), which the `isMissingGitPathError` regex below does NOT
    // match — without this branch the typed error leaked as an uncaught 500
    // (Better Stack pattern `5b40ec1a…`). Keep `isMissingGitPathError` as a
    // backstop for genuine `GitOperationError`s carrying the raw `fatal: path
    // … does not exist in …` message from callers that bypass `readRepoFile`.
    if (isRepoFileNotFoundError(error) || isMissingGitPathError(error)) {
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
  // Absolute and traversal paths can never resolve inside the repo tree —
  // e.g. the platform meta agent's /workspace/AGENTS.md lives in the sandbox
  // image, not the project repo. Answer like any other missing file.
  if (path.startsWith('/') || path.includes('..')) {
    return c.json({ error: 'File not found' }, 404);
  }
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_FILE_READ);

  // Visibility isolation: a scoped-out member can't read the commit history of
  // an agent/skill they aren't granted — return the same 404 as a missing file
  // so the path isn't confirmed to exist. Mirrors files/content (r5.ts:477-484).
  // See F-5 (weekly pentest run #4).
  const denier = await resourceDenierForRequest({
    userId: loaded.userId,
    accountId: loaded.row.accountId,
    projectId,
    actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
    row: loaded.row,
  });
  if (denier?.isDenied(path)) return c.json({ error: 'File not found' }, 404);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_READ);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_READ);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_READ);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_READ);

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
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_GITOPS_READ);

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
