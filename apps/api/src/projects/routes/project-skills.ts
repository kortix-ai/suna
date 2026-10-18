// POST /v1/projects/:projectId/skills — create a skill on the default branch.
//
// The Skills catalog's "New" control has two ways in: a configure chat session
// (an agent edits the repo on a branch — needs a model) and this form path,
// which commits `skills/<slug>/SKILL.md` directly. The form path needs no
// model, so a free account without a paid model can still create a skill —
// that was a dead end before (dogfood journey `skill-create-assign`: the chat
// turn stops with "requires a paid plan" and the model picker offers only
// Upgrade / Connect provider).
//
// Manager-gated on project.skill.write (the same leaf the agent-config editor
// and every other customize mutation use), threaded through
// assertProjectCapability so the agent-grant fold fires. One commit per
// create, straight onto the default branch — the same direct-commit shape the
// v2 agent-config PUT uses (routes/agent-config.ts), so the file lands
// immediately and the catalog's next config read sees it.

import { createRoute, z } from '@hono/zod-openapi';
import { slugifySlug } from '@kortix/manifest-schema';
import type { Context } from 'hono';
import type { AppEnv } from '../../types';

import { PROJECT_ACTIONS } from '../../iam/actions';
import { auth, errors, json } from '../../openapi';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from '../git/branches';
import { listRepoFiles } from '../git/files';
import { isRemotePushPolicyRejection } from '../git/mirror';
import { PROJECT_SKILL_SLUG_PATTERN, skillFolderFilePaths } from '../lib/project-resources';
import {
  assertAgentSessionWorkspaceAllowsRepository,
  assertProjectCapability,
  loadProjectForUser,
} from '../lib/access';
import { readManifest } from '../manifest-io';
import { projectSkillManifestEdit, renderSkillMarkdown } from '../lib/project-skill-edit';
import { projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';

/** Longest name/description the route accepts. Bounds one line of YAML. */
const SKILL_NAME_MAX = 100;
const SKILL_DESCRIPTION_MAX = 1024;

const CreateSkillSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(SKILL_NAME_MAX)
    // One YAML line, like the description: a newline would turn the name into
    // a block scalar the summary reader cannot parse.
    .transform((value) => value.replace(/\r?\n/g, ' ')),
  description: z
    .string()
    .trim()
    .max(SKILL_DESCRIPTION_MAX)
    // A description is one YAML line; a newline would turn it into a block
    // scalar the summary reader cannot parse.
    .transform((value) => value.replace(/\r?\n/g, ' '))
    .optional(),
});

export function registerProjectSkillsRoutes(): void {
  projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/skills',
    tags: ['projects'],
    summary: 'Create a skill on the default branch',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: CreateSkillSchema } } },
    },
    responses: {
      201: json(
        z.object({
          ok: z.literal(true),
          slug: z.string(),
          path: z.string(),
        }),
        'Created skill',
      ),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: Context<AppEnv>) => {
    const projectId = c.req.param('projectId');
    if (!projectId) return c.json({ error: 'Not found' }, 404);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A session whose workspace denies repository access must not reach the
    // repo, even with project.skill.write — the same gate every other
    // repo-writing route folds in before its capability check.
    await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
    );

    const parsed = CreateSkillSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid body', code: 'invalid_body', issues: parsed.error.issues },
        400,
      );
    }
    const skill = parsed.data;

    const slug = slugifySlug(skill.name, 'skill');
    const path = `skills/${slug}/SKILL.md`;

    const gitProject = await withProjectGitAuth(loaded.row);
    let manifestEdit: ReturnType<typeof projectSkillManifestEdit>;
    try {
      const manifest = await readManifest(gitProject, { forceRefresh: true, rethrowReadErrors: true });
      try {
        manifestEdit = projectSkillManifestEdit(manifest, slug, 'create');
      } catch (err) {
        const message = (err as Error).message;
        return c.json({ error: message }, message.includes('already exists') ? 409 : 400);
      }
    } catch (err) {
      return c.json({ error: `Failed to read the project manifest: ${(err as Error).message}`, code: 'manifest_read' }, 502);
    }
    try {
      const files = await listRepoFiles(gitProject, loaded.row.defaultBranch);
      // The tree listing is complete (`git ls-tree -r`): a folder at this slug
      // means the slug is taken. The create itself stays race-safe through the
      // manifest revision conflict below.
      if (skillFolderFilePaths(files, slug).length > 0) {
        return c.json({ error: `A skill named "${slug}" already exists`, code: 'skill_exists' }, 409);
      }
    } catch (err) {
      // Fail closed: any repo read error is a repo problem. Failing open here
      // would let a transient mirror error turn the create into a silent
      // overwrite of an existing skill.
      return c.json(
        {
          error: `Failed to read the project repo: ${(err as Error).message || String(err)}`,
          code: 'repo_read',
        },
        502,
      );
    }

    try {
      await commitMultipleFilesToBranch(gitProject, {
        ...manifestEdit,
        files: [...manifestEdit.files, { path, content: renderSkillMarkdown(skill, slug) }],
        message: `feat: add skill ${slug}`,
        branch: loaded.row.defaultBranch,
      });
    } catch (err) {
      if (err instanceof GitFileRevisionConflictError) {
        return c.json({ error: err.message }, 409);
      }
      if (isRemotePushPolicyRejection(err)) {
        return c.json(
          { error: 'The repository rejected the push', code: 'push_policy' },
          409,
        );
      }
      return c.json(
        { error: `Failed to commit the skill: ${(err as Error).message || String(err)}` },
        502,
      );
    }

    return c.json({ ok: true as const, slug, path }, 201);
  },
);

// DELETE /v1/projects/:projectId/skills/:slug — remove a skill folder from the
// default branch. The complement of the form create above: once a skill is
// listed (and now linked, runnable, deletable), deleting it is the same
// direct-commit shape — every file under `skills/<slug>/` (the SKILL.md plus
// any references the skill collected) goes in one commit.
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/skills/{slug}',
    tags: ['projects'],
    summary: 'Delete a skill folder from the default branch',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), slug: z.string() }),
    },
    responses: {
      200: json(
        z.object({
          ok: z.literal(true),
          slug: z.string(),
          deleted: z.number().int().nonnegative(),
        }),
        'Deleted skill',
      ),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: Context<AppEnv>) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug') ?? '';
    if (!projectId) return c.json({ error: 'Not found' }, 404);
    if (!PROJECT_SKILL_SLUG_PATTERN.test(slug)) {
      return c.json({ error: 'Invalid skill slug', code: 'invalid_slug' }, 400);
    }
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SKILL_WRITE,
    );

    const gitProject = await withProjectGitAuth(loaded.row);
    let repoFiles: Array<{ path: string }>;
    let manifestEdit: ReturnType<typeof projectSkillManifestEdit>;
    try {
      const manifest = await readManifest(gitProject, { forceRefresh: true, rethrowReadErrors: true });
      try {
        manifestEdit = projectSkillManifestEdit(manifest, slug, 'delete');
      } catch (err) {
        return c.json({ error: (err as Error).message, code: 'invalid_slug' }, 400);
      }
      repoFiles = await listRepoFiles(gitProject, loaded.row.defaultBranch);
    } catch (err) {
      return c.json(
        { error: `Failed to read the project repo: ${(err as Error).message || String(err)}`, code: 'repo_read' },
        502,
      );
    }
    const deletes = skillFolderFilePaths(repoFiles, slug);
    if (deletes.length === 0) {
      return c.json({ error: `No skill folder "${slug}" exists`, code: 'skill_not_found' }, 404);
    }

    try {
      await commitMultipleFilesToBranch(gitProject, {
        ...manifestEdit,
        deletes,
        message: `chore: remove skill ${slug}`,
        branch: loaded.row.defaultBranch,
      });
    } catch (err) {
      if (err instanceof GitFileRevisionConflictError) {
        return c.json({ error: err.message }, 409);
      }
      if (isRemotePushPolicyRejection(err)) {
        return c.json({ error: 'The repository rejected the push', code: 'push_policy' }, 409);
      }
      return c.json(
        { error: `Failed to commit the deletion: ${(err as Error).message || String(err)}` },
        502,
      );
    }

    return c.json({ ok: true as const, slug, deleted: deletes.length }, 200);
  },
);
}
