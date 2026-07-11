/**
 * /v1/templates — installable use-case templates (a `registry:template` bundle
 * + declared inputs). Read routes are public (they power the "Use this template"
 * button and the install wizard's preview); installing is auth-scoped.
 *
 *   GET  /v1/templates              → list templates
 *   GET  /v1/templates/{id}         → detail: inputs + requirement preview
 *   POST /v1/templates/{id}/install → apply into a project + commit (auth)
 */

import { createRoute, z } from '@hono/zod-openapi';

import { executorConnectors } from '@kortix/db';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { eq } from 'drizzle-orm';

import { db } from '../../shared/db';

import { findCatalogEntryByName, listCatalogItemsLive } from '../../marketplace/catalog';
import { buildInstall } from '../../marketplace/install-service';
import { config } from '../../config';
import { supabaseAuth } from '../../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { commitMultipleFilesToBranch } from '../git/branches';
import { readManifestFromRepo, readRepoFile } from '../git/files';
import { assertCommitCapabilities, loadProjectForUser } from '../lib/access';
import { loadGitProject } from '../lib/git';
import { listProjectSecrets } from '../secrets';
import { buildTemplateInstall, parseTemplateBlock } from './apply-template';

export const templatesApp = makeOpenApiApp<AppEnv>();

// Single kill-switch (KORTIX_TEMPLATES_ENABLED) — every template route 404s
// while the feature is off, so it stays invisible in prod.
templatesApp.use('*', async (c, next) => {
  if (!config.KORTIX_TEMPLATES_ENABLED) return c.json({ error: 'Not found' }, 404);
  await next();
});

// Read routes (list + detail) are public; installing requires auth.
templatesApp.use('/:id/install', supabaseAuth);

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

/** Resolve a template, install-plan it, and build against a target manifest. */
async function previewOrBuild(input: {
  id: string;
  inputs: Record<string, string>;
  context?: Record<string, string>;
  manifestRaw: string | null;
  manifestPath: string;
  existingConnectors: Array<{ slug: string; provider: string }>;
  existingSecretKeys: string[];
}) {
  const entry = await findCatalogEntryByName(input.id);
  if (!entry || entry.item.type !== 'registry:template') return null;

  const built = await buildInstall({
    id: input.id,
    configDir: '.kortix/opencode',
    existingLockRaw: null,
    legacyLockRaw: null,
    now: new Date().toISOString(),
  });

  const result = buildTemplateInstall({
    template: entry.item,
    block: parseTemplateBlock(entry.item),
    registryFiles: built.files,
    capabilities: built.capabilities,
    inputs: input.inputs,
    context: input.context,
    manifestRaw: input.manifestRaw,
    manifestPath: input.manifestPath,
    existingConnectors: input.existingConnectors,
    existingSecretKeys: input.existingSecretKeys,
  });
  return { entry, built, result };
}

templatesApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['templates'],
    summary: 'GET /templates',
    responses: { 200: json(z.any(), 'Installable templates') },
  }),
  async (c: any) => {
    const items = await listCatalogItemsLive({ type: 'registry:template' });
    return c.json({ templates: items });
  },
);

templatesApp.openapi(
  createRoute({
    method: 'get',
    path: '/{id}',
    tags: ['templates'],
    summary: 'GET /templates/:id',
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: json(z.any(), 'Template detail + requirement preview'), ...errors(404) },
  }),
  async (c: any) => {
    const preview = await previewOrBuild({
      id: c.req.param('id'),
      inputs: {},
      manifestRaw: null,
      manifestPath: 'kortix.yaml',
      existingConnectors: [],
      existingSecretKeys: [],
    });
    if (!preview) return c.json({ error: 'Not found' }, 404);
    const { entry, built, result } = preview;
    return c.json({
      id: entry.item.name,
      title: entry.item.title ?? entry.item.name,
      description: entry.item.description ?? null,
      inputs: entry.item.inputs ?? [],
      requirements: result.requirements,
      installs: built.installed,
      connectors: built.capabilities.connectors,
      secrets: built.capabilities.secrets,
    });
  },
);

templatesApp.openapi(
  createRoute({
    method: 'post',
    path: '/{id}/install',
    tags: ['templates'],
    summary: 'POST /templates/:id/install',
    ...auth,
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              project_id: z.string(),
              inputs: z.record(z.string()).default({}),
            }),
          },
        },
      },
    },
    responses: {
      201: json(z.any(), 'Installed'),
      ...errors(400, 401, 404),
    },
  }),
  async (c: any) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const projectId = typeof body?.project_id === 'string' ? body.project_id : '';
    if (!projectId) return c.json({ error: 'project_id is required' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const project = await loadGitProject(loaded);
    const manifestRaw = await manifestRawOrNull(project);
    const connectors: Array<{ slug: string; providerType: string }> = await db
      .select({ slug: executorConnectors.slug, providerType: executorConnectors.providerType })
      .from(executorConnectors)
      .where(eq(executorConnectors.projectId, projectId))
      .catch(() => []);
    const secretKeys = Object.keys(await listProjectSecrets(projectId).catch(() => ({})));

    const preview = await previewOrBuild({
      id,
      inputs: body?.inputs ?? {},
      context: { projectName: loaded.row.name },
      manifestRaw,
      manifestPath: manifestCandidatePaths(project.manifestPath)[0].path,
      existingConnectors: connectors.map((cn) => ({ slug: cn.slug, provider: String(cn.providerType) })),
      existingSecretKeys: secretKeys,
    });
    if (!preview) return c.json({ error: `Unknown template "${id}"` }, 404);
    const { entry, result } = preview;

    await assertCommitCapabilities(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      result.files.map((f) => f.path),
    );

    const commit = await commitMultipleFilesToBranch(project, {
      files: result.files,
      message: `feat(template): install ${entry.item.title ?? entry.item.name}`,
      branch: project.defaultBranch,
    });

    return c.json(
      {
        ok: true,
        project_id: projectId,
        commit_sha: commit.commitSha,
        branch: commit.branch,
        requirements: result.requirements,
        trigger_slugs: result.triggerSlugs,
      },
      201,
    );
  },
);
