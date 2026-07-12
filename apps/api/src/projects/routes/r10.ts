/**
 * Marketplace install — project-scoped.
 *
 *   POST /:projectId/marketplace/install { id } → commit an item's files (+ lock)
 *                                                  onto the default branch, live
 *                                                  in the next session.
 *   GET  /:projectId/marketplace                → what's installed (from the lock).
 *
 * The old /registry routes remain as compatibility aliases.
 *
 * Reuses @kortix/registry server-side: resolve from the catalog, plan the
 * install (with transitive bundle deps), and commit every file atomically via
 * the provider-agnostic multi-file git helper.
 */

import { createRoute, z } from '@hono/zod-openapi';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { compareInstalled, parseLockContent, serializeLock } from '@kortix/registry';
import { getCatalogEntry, getCatalogItemDetail, resolveOpencodeDir } from '../../marketplace/catalog';
import {
  buildInstall,
  buildInstallBatch,
  catalogIdForName,
  resolveItemFiles,
} from '../../marketplace/install-service';
import { auth, errors, json } from '../../openapi';
import { commitMultipleFilesToBranch } from '../git/branches';
import { readManifestFromRepo, readRepoFile } from '../git/files';
import { assertCommitCapabilities, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { loadGitProject } from '../lib/git';
import { readBody, requestAuditContext } from '../lib/serializers';
import { createProjectSession, sendSessionCreateError } from '../lib/sessions';

async function repoFileOrNull(
  project: Parameters<typeof readRepoFile>[0],
  path: string,
): Promise<string | null> {
  try {
    return await readRepoFile(project, path, project.defaultBranch);
  } catch {
    return null;
  }
}

/** The project's manifest raw text, preferring kortix.yaml over kortix.toml
 *  (dual-format). resolveOpencodeDir reads either format's `config_dir`. */
async function manifestRawOrNull(
  project: Parameters<typeof readRepoFile>[0],
): Promise<string | null> {
  const found = await readManifestFromRepo(
    project,
    manifestCandidatePaths(project.manifestPath).map((cand) => cand.path),
    project.defaultBranch,
  ).catch(() => null);
  return found?.content ?? null;
}

async function handleMarketplaceInstall(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return c.json({ error: 'id is required' }, 400);
  const detail = await getCatalogItemDetail(id);
  if (!detail) return c.json({ error: `Unknown item "${id}"` }, 400);
  // registry:project items are whole-project scaffolds (kortix.yaml + agents) —
  // a deterministic file commit here would clobber this project's own
  // kortix.yaml. Cloning as a new project (POST /provision, source_item_id) or
  // the agent-driven merge below (POST /marketplace/install-session) are the
  // two supported ways to bring a project item in.
  if (detail.type === 'registry:project') {
    return c.json(
      {
        error:
          'This item is a whole project — clone it as a new project, or use /marketplace/install-session to have an agent merge it into this one.',
      },
      400,
    );
  }

  const project = await loadGitProject(loaded);
  const manifestRaw = await manifestRawOrNull(project);
  const configDir = resolveOpencodeDir(manifestRaw);
  const existingLockRaw = await repoFileOrNull(project, 'registry-lock.json');
  const legacyLockRaw = await repoFileOrNull(project, 'skills-lock.json');

  let built;
  try {
    built = await buildInstall({
      id,
      configDir,
      existingLockRaw,
      legacyLockRaw,
      now: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // Per-capability gate: installing an agent needs project.agent.write, a skill
  // project.skill.write, etc. — so a role can be scoped to install some resource
  // types but not others. (Editor/Manager hold them all; the agent-grant fold
  // still fires through assertProjectCapability.)
  await assertCommitCapabilities(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    built.files.map((f) => f.path),
  );

  const commit = await commitMultipleFilesToBranch(project, {
    files: built.files,
    message: `feat(marketplace): add ${detail.title}`,
    branch: project.defaultBranch,
  });

  return c.json(
    {
      ok: true,
      commit_sha: commit.commitSha,
      branch: commit.branch,
      file_count: commit.fileCount,
      installed: built.installed,
      capabilities: built.capabilities,
    },
    201,
  );
}

/** Build the initial prompt for an agent-driven merge of a `registry:project`
 *  item into an EXISTING project. Unlike `handleMarketplaceInstall`'s
 *  deterministic commit, this is judgment-heavy (does the incoming agent
 *  persona collide with one that already exists? does the target project
 *  even want a new default agent?) — so an agent reads both sides and opens
 *  a change request rather than a blind file overwrite. */
function buildRegistryProjectInstallPrompt(
  entry: NonNullable<Awaited<ReturnType<typeof getCatalogEntry>>>,
  targetManifestRaw: string | null,
): string {
  const item = entry.item;
  const ownFiles = (item.files ?? []).filter((f) => typeof f.content === 'string');
  const deps = item.registryDependencies ?? [];

  const lines: string[] = [
    `Integrate the "${item.title ?? item.name}" project template into THIS project — without breaking anything already here.`,
    '',
    item.description ?? '',
    '',
    "This project's current kortix.yaml:",
    '```yaml',
    targetManifestRaw ?? '(no manifest found)',
    '```',
    '',
    'The template contributes these files. Its own kortix.yaml is a reference for what agent it expects to exist — do NOT overwrite this project\'s kortix.yaml with it verbatim.',
  ];
  for (const file of ownFiles) {
    lines.push('', `--- ${file.path} ---`, '```', file.content ?? '', '```');
  }
  if (deps.length > 0) {
    lines.push(
      '',
      "It also depends on these marketplace skills — install each one (they're additive, they won't conflict with anything already installed):",
      ...deps.map((d) => `- ${d}`),
    );
  }
  lines.push(
    '',
    'Steps:',
    "1. Read this project's current kortix.yaml and .kortix/opencode/agents/ to see what already exists.",
    '2. Add the template\'s agent persona as a new agent file — rename it if the name collides with an existing agent. Do not remove or overwrite any existing agent.',
    "3. Merge the template's kortix.yaml `agents:` entry for that agent into this project's kortix.yaml. Leave default_agent and every other existing agent untouched unless the user asks otherwise.",
    '4. Install the marketplace skills listed above.',
    '5. Open a change request with the result — do not push directly to the default branch.',
  );
  return lines.join('\n');
}

async function handleMarketplaceInstallSession(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return c.json({ error: 'id is required' }, 400);

  const entry = await getCatalogEntry(id);
  if (!entry || entry.item.type !== 'registry:project') {
    return c.json({ error: `Unknown or non-project item "${id}" — this endpoint only merges whole projects.` }, 400);
  }

  const project = await loadGitProject(loaded);
  const manifestRaw = await manifestRawOrNull(project);
  const prompt = buildRegistryProjectInstallPrompt(entry, manifestRaw);

  const result = await createProjectSession({
    project: loaded.row,
    userId: loaded.userId,
    body: {
      initial_prompt: prompt,
      name: `Add ${entry.item.title ?? entry.item.name}`,
      metadata: { kind: 'registry-project-install', item_id: id },
    },
    visibility: 'project',
    request: requestAuditContext(c),
  });
  if (result.error) return sendSessionCreateError(c, result.error);

  return c.json({ session_id: result.row!.sessionId }, 201);
}

async function handleMarketplaceInstalled(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  const lockRaw = await repoFileOrNull(project, 'registry-lock.json');
  const legacyRaw = await repoFileOrNull(project, 'skills-lock.json');
  const lock = parseLockContent(lockRaw, legacyRaw);

  return c.json({
    installed: Object.entries(lock.items).map(([name, e]) => ({
      name,
      type: e.type,
      source: e.source,
      installed_at: e.installedAt ?? null,
      file_count: e.files.length,
    })),
  });
}

async function handleMarketplaceUpdates(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const updates = await resolveMarketplaceUpdates(loaded);
  return c.json({
    updates,
    update_available: updates.filter((u) => u.status === 'update-available').map((u) => u.name),
  });
}

async function resolveMarketplaceUpdates(
  loaded: NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>,
) {
  const project = await loadGitProject(loaded);
  const manifestRaw = await manifestRawOrNull(project);
  const configDir = resolveOpencodeDir(manifestRaw);
  const lock = parseLockContent(
    await repoFileOrNull(project, 'registry-lock.json'),
    await repoFileOrNull(project, 'skills-lock.json'),
  );

  const updates = await Promise.all(
    Object.entries(lock.items).map(async ([name, e]) => {
      let fresh: Awaited<ReturnType<typeof resolveItemFiles>> = null;
      try {
        fresh = await resolveItemFiles(name, configDir);
      } catch {
        fresh = null;
      }
      const diff = compareInstalled(e.files, fresh);
      return {
        name,
        type: e.type,
        status: diff.status,
        changed: diff.changed.length + diff.added.length + diff.removed.length,
      };
    }),
  );
  return updates;
}

async function handleMarketplaceUpdate(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const body = await readBody(c);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);

  const id = await catalogIdForName(name);
  if (!id)
    return c.json({ error: `"${name}" is not in the catalog — cannot update (orphaned)` }, 400);

  const project = await loadGitProject(loaded);
  const manifestRaw = await manifestRawOrNull(project);
  const configDir = resolveOpencodeDir(manifestRaw);

  let built;
  try {
    built = await buildInstall({
      id,
      configDir,
      existingLockRaw: await repoFileOrNull(project, 'registry-lock.json'),
      legacyLockRaw: await repoFileOrNull(project, 'skills-lock.json'),
      now: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // Per-capability gate on the resource types this update rewrites.
  await assertCommitCapabilities(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    built.files.map((f) => f.path),
  );

  const commit = await commitMultipleFilesToBranch(project, {
    files: built.files,
    message: `chore(marketplace): update ${name}`,
    branch: project.defaultBranch,
  });

  return c.json({
    ok: true,
    updated: name,
    commit_sha: commit.commitSha,
    branch: commit.branch,
    file_count: commit.fileCount,
    installed: built.installed,
  });
}

async function handleMarketplaceUpdateAll(c: any) {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const updates = await resolveMarketplaceUpdates(loaded);
  const names = updates.filter((u) => u.status === 'update-available').map((u) => u.name);
  if (names.length === 0) {
    return c.json({
      ok: true,
      updated: [],
      commit_sha: null,
      branch: null,
      file_count: 0,
      installed: [],
    });
  }

  const project = await loadGitProject(loaded);
  const manifestRaw = await manifestRawOrNull(project);
  const configDir = resolveOpencodeDir(manifestRaw);

  let built;
  try {
    const ids = await Promise.all(
      names.map(async (name) => {
        const id = await catalogIdForName(name);
        if (!id) throw new Error(`"${name}" is not in the catalog — cannot update (orphaned)`);
        return id;
      }),
    );
    built = await buildInstallBatch({
      ids,
      configDir,
      existingLockRaw: await repoFileOrNull(project, 'registry-lock.json'),
      legacyLockRaw: await repoFileOrNull(project, 'skills-lock.json'),
      now: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // Per-capability gate on the resource types this bulk update rewrites.
  await assertCommitCapabilities(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    built.files.map((f) => f.path),
  );

  const commit = await commitMultipleFilesToBranch(project, {
    files: built.files,
    message: `chore(marketplace): update ${names.length} item${names.length === 1 ? '' : 's'}`,
    branch: project.defaultBranch,
  });

  return c.json({
    ok: true,
    updated: names,
    commit_sha: commit.commitSha,
    branch: commit.branch,
    file_count: commit.fileCount,
    installed: built.installed,
  });
}

async function handleMarketplaceRemove(c: any) {
  const projectId = c.req.param('projectId');
  const name = c.req.param('name');
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  const project = await loadGitProject(loaded);
  const lock = parseLockContent(
    await repoFileOrNull(project, 'registry-lock.json'),
    await repoFileOrNull(project, 'skills-lock.json'),
  );
  const entry = lock.items[name];
  if (!entry) return c.json({ error: `"${name}" is not installed` }, 404);

  const deletes = entry.files.map((f) => f.target);
  // Per-capability gate on the resource type being removed (an agent removal
  // needs project.agent.write, a skill project.skill.write, …).
  await assertCommitCapabilities(c, loaded.userId, loaded.row.accountId, projectId, deletes);
  delete lock.items[name];

  const commit = await commitMultipleFilesToBranch(project, {
    files: [{ path: 'registry-lock.json', content: serializeLock(lock) }],
    deletes,
    message: `chore(marketplace): remove ${name}`,
    branch: project.defaultBranch,
  });

  return c.json({
    ok: true,
    removed: name,
    commit_sha: commit.commitSha,
    branch: commit.branch,
    file_count: deletes.length,
  });
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/marketplace/install',
    tags: ['marketplace'],
    summary: 'POST /:projectId/marketplace/install',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Installed'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceInstall,
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/registry/install',
    tags: ['marketplace'],
    summary: 'POST /:projectId/registry/install',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Installed'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceInstall,
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/marketplace/install-session',
    tags: ['marketplace'],
    summary: 'POST /:projectId/marketplace/install-session',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(z.any(), 'Session started'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceInstallSession,
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/marketplace',
    tags: ['marketplace'],
    summary: 'GET /:projectId/marketplace',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Installed marketplace items'),
      ...errors(404),
    },
  }),
  handleMarketplaceInstalled,
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/registry',
    tags: ['marketplace'],
    summary: 'GET /:projectId/registry',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Installed registry items'),
      ...errors(404),
    },
  }),
  handleMarketplaceInstalled,
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/marketplace/updates',
    tags: ['marketplace'],
    summary: 'GET /:projectId/marketplace/updates',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Per-item update status'),
      ...errors(404),
    },
  }),
  handleMarketplaceUpdates,
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/marketplace/update',
    tags: ['marketplace'],
    summary: 'POST /:projectId/marketplace/update',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'Updated'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceUpdate,
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/marketplace/update-all',
    tags: ['marketplace'],
    summary: 'POST /:projectId/marketplace/update-all',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Updated all outdated marketplace items'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceUpdateAll,
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/marketplace/{name}',
    tags: ['marketplace'],
    summary: 'DELETE /:projectId/marketplace/:name',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Removed'),
      ...errors(404),
    },
  }),
  handleMarketplaceRemove,
);

// What's outdated — re-resolve each installed item from source, re-hash, and
// compare to the lock. The "Updates available (N)" loop, WordPress-style.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/registry/updates',
    tags: ['marketplace'],
    summary: 'GET /:projectId/registry/updates',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Per-item update status'),
      ...errors(404),
    },
  }),
  handleMarketplaceUpdates,
);

// Re-install an item from source (overwrites its files + refreshes the lock
// hashes) — the "Update" button.
projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/registry/update',
    tags: ['marketplace'],
    summary: 'POST /:projectId/registry/update',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.any(), 'Updated'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceUpdate,
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/registry/update-all',
    tags: ['marketplace'],
    summary: 'POST /:projectId/registry/update-all',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Updated all outdated registry items'),
      ...errors(400, 404),
    },
  }),
  handleMarketplaceUpdateAll,
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/registry/{name}',
    tags: ['marketplace'],
    summary: 'DELETE /:projectId/registry/:name',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), name: z.string() }),
    },
    responses: {
      200: json(z.any(), 'Removed'),
      ...errors(404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const name = c.req.param('name');
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const project = await loadGitProject(loaded);
    const lock = parseLockContent(
      await repoFileOrNull(project, 'registry-lock.json'),
      await repoFileOrNull(project, 'skills-lock.json'),
    );
    const entry = lock.items[name];
    if (!entry) return c.json({ error: `"${name}" is not installed` }, 404);

    const deletes = entry.files.map((f) => f.target);
    // Per-capability gate on the resource type being removed.
    await assertCommitCapabilities(c, loaded.userId, loaded.row.accountId, projectId, deletes);
    delete lock.items[name];

    const commit = await commitMultipleFilesToBranch(project, {
      files: [{ path: 'registry-lock.json', content: serializeLock(lock) }],
      deletes,
      message: `chore(registry): remove ${name}`,
      branch: project.defaultBranch,
    });

    return c.json({
      ok: true,
      removed: name,
      commit_sha: commit.commitSha,
      branch: commit.branch,
      file_count: deletes.length,
    });
  },
);
