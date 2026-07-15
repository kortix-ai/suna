/**
 * /v1/templates — installable use-case templates (a `registry:template` bundle
 * + declared inputs). Read routes are public (they power the "Use this template"
 * button and the install wizard's preview); installing is auth-scoped.
 *
 *   GET  /v1/templates              → list templates
 *   GET  /v1/templates/{id}         → detail: inputs + requirement preview
 *   POST /v1/templates/{id}/install → apply into a project + commit (auth)
 *
 * Installing shares the template-aware slice of the marketplace install system
 * (see ./install-template): the same render + manifest-merge runs whether you
 * come through here or `POST /projects/:id/marketplace/install`.
 */

import { createRoute, z } from '@hono/zod-openapi';

import { listTemplateCatalogItems } from '../../marketplace/catalog';
import { config } from '../../config';
import { supabaseAuth } from '../../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { commitMultipleFilesToBranch } from '../git/branches';
import { readManifestFromRepo, readRepoFile } from '../git/files';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { assertCommitCapabilities, loadProjectForUser } from '../lib/access';
import { loadGitProject } from '../lib/git';
import {
  buildTemplateDetail,
  buildTemplateInstallForProject,
  primaryManifestPath,
} from './install-template';

export const templatesApp = makeOpenApiApp<AppEnv>();

// Single kill-switch (KORTIX_TEMPLATES_ENABLED) — every template route 404s
// while the feature is off, so it stays invisible in prod.
templatesApp.use('*', async (c, next) => {
  if (!config.KORTIX_TEMPLATES_ENABLED) return c.json({ error: 'Not found' }, 404);
  await next();
});

// Read routes (list + detail) are public; installing requires auth.
templatesApp.use('/:id/install', supabaseAuth);

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

templatesApp.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['templates'],
    summary: 'GET /templates',
    responses: { 200: json(z.any(), 'Installable templates') },
  }),
  async (c: any) => {
    const items = await listTemplateCatalogItems();
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
    const detail = await buildTemplateDetail(c.req.param('id'));
    if (!detail) return c.json({ error: 'Not found' }, 404);
    return c.json(detail);
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

    const preview = await buildTemplateInstallForProject({
      projectId,
      projectName: loaded.row.name,
      manifestRaw,
      manifestPath: primaryManifestPath(project.manifestPath),
      id,
      inputs: body?.inputs ?? {},
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
