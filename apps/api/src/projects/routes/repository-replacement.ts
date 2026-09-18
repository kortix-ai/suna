import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { kickProjectTemplatePrebuilds } from '../../snapshots/builder';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import { projectsApp, ProjectSchema } from '../lib/app';
import { RepositoryChangedError, RepositoryManifestMissingError, RepositorySecretCopyError, RepositoryValidationError, replaceProjectRepository } from '../lib/repository-replacement';
import { serializeProject, serializeProjectGitConnection } from '../lib/serializers';

const Body = z.object({
  repo_url: z.string().url(),
  expected_repo_url: z.string().url(),
  github_token: z.string().min(1).optional(),
  installation_id: z.string().min(1).optional(),
  github_user_token: z.string().min(1).optional(),
  copy_shared_secrets_from_project_id: z.string().uuid().optional(),
  copy_shared_secret_identifiers: z.array(z.string().min(1)).min(1).max(20).optional(),
}).strict().refine((body) => Boolean(body.github_token) !== Boolean(body.installation_id && body.github_user_token), {
  message: 'Provide either a GitHub token or an installation and GitHub user authorization',
}).refine((body) => Boolean(body.copy_shared_secrets_from_project_id) === Boolean(body.copy_shared_secret_identifiers), {
  message: 'Secret source and identifiers must be provided together',
});

projectsApp.openapi(createRoute({
  method: 'put',
  path: '/{projectId}/git/repository',
  tags: ['github'],
  summary: 'Replace the Git repository for an existing project',
  ...auth,
  request: {
    params: z.object({ projectId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: Body } } },
  },
  responses: {
    200: json(z.object({ project: ProjectSchema, git_connection: z.any() }), 'Updated project and Git connection'),
    ...errors(400, 403, 404, 409),
  },
}), async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);

  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid repository replacement request' }, 400);
  if (parsed.data.copy_shared_secrets_from_project_id) {
    const source = await loadProjectForUser(c, parsed.data.copy_shared_secrets_from_project_id, 'manage');
    if (!source || source.row.accountId !== loaded.row.accountId) return c.json({ error: 'Secret source project not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
    await assertProjectCapability(c, source.userId, source.row.accountId, source.row.projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);
  }
  try {
    const { project, connection, gitAuthToken } = await replaceProjectRepository({
      projectId,
      accountId: loaded.row.accountId,
      actorId: loaded.userId,
      repoUrl: parsed.data.repo_url,
      expectedRepoUrl: parsed.data.expected_repo_url,
      token: parsed.data.github_token ?? '',
      installationId: parsed.data.installation_id,
      githubUserToken: parsed.data.github_user_token,
      copySharedSecrets: parsed.data.copy_shared_secrets_from_project_id
        ? { sourceProjectId: parsed.data.copy_shared_secrets_from_project_id,
            identifiers: parsed.data.copy_shared_secret_identifiers! }
        : undefined,
    });
    try {
      kickProjectTemplatePrebuilds({
        projectId, repoUrl: project.repoUrl,
        defaultBranch: project.defaultBranch,
        manifestPath: project.manifestPath,
        gitAuthToken,
      }, { accountId: project.accountId, source: 'project-repository-replacement' });
    } catch (error) {
      console.warn('[projects] repository replacement committed but template prebuild failed', {
        projectId, error: error instanceof Error ? error.message : String(error),
      });
    }
    return c.json({
      project: serializeProject(project, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }),
      git_connection: serializeProjectGitConnection(connection),
    });
  } catch (error) {
    if (error instanceof RepositoryChangedError || error instanceof RepositorySecretCopyError) return c.json({ error: error.message }, 409);
    if (error instanceof RepositoryManifestMissingError || error instanceof RepositoryValidationError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});
