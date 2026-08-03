import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { auth, errors, json } from '../../openapi';
import type { AppEnv } from '../../types';
import { createChangeRequestForBranch, serializeChangeRequest } from '../change-requests';
import { listRepoFiles, loadProjectConfig } from '../git';
import {
  commitMultipleFilesToBranch,
  createRemoteSessionBranch,
  deleteRemoteSessionBranch,
} from '../git/branches';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import {
  AgentSkillImportError,
  assertProjectSkillSlugsAvailable,
  normalizeProjectSkillImport,
  projectSkillImportBranchName,
  projectSkillImportTarget,
  summarizeProjectSkillImport,
} from '../lib/project-skills-import';

const ImportProjectSkillSchema = z.object({
  fileName: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
});

type ProjectSkillImportContext = Context<AppEnv>;

function skillImportErrorResponse(c: ProjectSkillImportContext, error: unknown) {
  if (error instanceof AgentSkillImportError) {
    const status = error.code === 'project_skill_slug_duplicate' ? 409 : 400;
    return c.json({ error: error.message, code: error.code }, status);
  }
  throw error;
}

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/skills/import',
    tags: ['projects'],
    summary: 'Import a project skill file or archive',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: { 'application/json': { schema: ImportProjectSkillSchema } },
      },
    },
    responses: {
      201: json(z.any(), 'Created skill import change request'),
      ...errors(400, 403, 404, 409, 422, 500, 502),
    },
  }),
  async (c: ProjectSkillImportContext) => {
    const projectId = c.req.param('projectId');
    if (!projectId) return c.json({ error: 'projectId is required' }, 400);
    const loaded = await loadProjectForUser(c, projectId, 'write');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
    );
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_GITOPS_PUSH,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CR_OPEN);

    const parsed = ImportProjectSkillSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'Invalid body',
          code: 'invalid_body',
          issues: parsed.error.issues,
        },
        400,
      );
    }

    let normalized: Awaited<ReturnType<typeof normalizeProjectSkillImport>>;
    try {
      normalized = await normalizeProjectSkillImport(parsed.data);
    } catch (error) {
      return skillImportErrorResponse(c, error);
    }

    const gitProject = await withProjectGitAuth(loaded.row);
    try {
      const files = await listRepoFiles(gitProject, loaded.row.defaultBranch);
      const config = await loadProjectConfig(gitProject, files);
      assertProjectSkillSlugsAvailable(normalized.skills, config.skills);
    } catch (error) {
      if (error instanceof AgentSkillImportError) return skillImportErrorResponse(c, error);
      return c.json(
        {
          error: `Failed to inspect project skills: ${error instanceof Error ? error.message : String(error)}`,
          code: 'skill_config_read_failed',
        },
        502,
      );
    }

    const branch = projectSkillImportBranchName(normalized.skills);
    const singleSkillSlug = normalized.skills.length === 1 ? normalized.skills[0]?.slug : null;
    try {
      await createRemoteSessionBranch(gitProject, branch, loaded.row.defaultBranch);
      const committed = await commitMultipleFilesToBranch(gitProject, {
        branch,
        files: normalized.skills.flatMap((skill) => skill.files),
        message: singleSkillSlug
          ? `chore: import skill ${singleSkillSlug}`
          : `chore: import ${normalized.skills.length} skills`,
      });
      const title = singleSkillSlug
        ? `Import skill ${singleSkillSlug}`
        : `Import ${normalized.skills.length} skills`;
      const result = await createChangeRequestForBranch({
        accountId: loaded.row.accountId,
        projectId,
        userId: loaded.userId,
        projectForGit: gitProject,
        title,
        description: `Adds ${normalized.paths.length} file${
          normalized.paths.length === 1 ? '' : 's'
        } under .kortix/opencode/skills.`,
        baseRef: loaded.row.defaultBranch,
        headRef: branch,
        metadata: {
          project_skill_import: {
            skills: normalized.skills.map((skill) => skill.slug),
            paths: normalized.paths,
          },
        },
      });
      if (!result.ok) {
        await deleteRemoteSessionBranch(gitProject, branch).catch(() => undefined);
        return c.json(result.body, result.status);
      }
      return c.json(
        {
          skills: summarizeProjectSkillImport(normalized.skills),
          paths: normalized.paths,
          branch,
          target: projectSkillImportTarget(loaded.row, branch),
          commit_sha: committed.commitSha,
          change_request: serializeChangeRequest(result.row),
        },
        201,
      );
    } catch (error) {
      await deleteRemoteSessionBranch(gitProject, branch).catch(() => undefined);
      return c.json(
        {
          error: `Failed to import skill: ${error instanceof Error ? error.message : String(error)}`,
          code: 'skill_import_failed',
        },
        502,
      );
    }
  },
);
