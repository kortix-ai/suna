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
import { slugifySlug, validateManifest } from '@kortix/manifest-schema';
import { stringify as stringifyYaml } from 'yaml';
import type { Context } from 'hono';
import type { AppEnv } from '../../types';

import { PROJECT_ACTIONS } from '../../iam/actions';
import { auth, errors, json } from '../../openapi';
import { GitFileRevisionConflictError, commitFileToBranch, commitMultipleFilesToBranch } from '../git/branches';
import { isRepoFileNotFoundError, readRepoFile, listRepoFiles } from '../git/files';
import { isRemotePushPolicyRejection } from '../git/mirror';
import {
  assertAgentSessionWorkspaceAllowsRepository,
  assertProjectCapability,
  loadProjectForUser,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';

import { readManifest, manifestWrites } from '../manifest-io';
import { resolveBranchTip } from '../git/commits';
import { refreshMirror } from '../git/mirror';
import { invalidateProjectResourceConfig } from '../lib/project-resources';
import { planSkillRemoval } from '../lib/skill-removal';
import { logger } from '../../lib/logger';
import { isRepositoryDisconnectedError } from '../../shared/repository-health';

/** Longest name/description the route accepts. Bounds one line of YAML. */
const SKILL_NAME_MAX = 100;
const SKILL_DESCRIPTION_MAX = 1024;

const RemoveSkillSchema = z.object({ folder: z.string().min(1).max(1024), confirm: z.literal(true) });

const CreateSkillSchema = z.object({
  body: z.string().optional(),
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
type CreateSkillInput = z.infer<typeof CreateSkillSchema>;

/** The committed file's full text: frontmatter (real YAML, the same writer
 *  `serializeAgentMarkdown` uses) plus the supplied or starter body. `lineWidth: 0` keeps
 *  every scalar on one line, which is what the summary's frontmatter reader
 *  parses. */
function renderSkillMarkdown(skill: CreateSkillInput): string {
  const frontmatter: Record<string, string> = { name: skill.name };
  if (skill.description) frontmatter.description = skill.description;
  const header = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  const body = skill.body?.trim() ? skill.body : [
    `# ${skill.name}`,
    '',
    ...(skill.description ? [skill.description, ''] : []),
    'Describe when the agent should load this skill and what to do. Edit this file',
    'in the repo, or ask an agent in chat to extend it.',
    '',
  ].join('\n');
  return `---\n${header}\n---\n\n${body}`;
}

/** Whether `predicate` holds for the error or any error in its cause chain. */
function hasCause(error: unknown, predicate: (candidate: unknown) => boolean): boolean {
  for (let depth = 0, current = error; current && depth < 5; depth += 1) {
    if (predicate(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function registerProjectSkillsRoutes(): void {
  projectsApp.openapi(createRoute({
    method: 'post', path: '/{projectId}/skills/remove', tags: ['projects'],
    summary: 'Remove a selected project skill folder, including edits', ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: RemoveSkillSchema } } },
    },
    responses: { 200: json(z.object({ ok: z.literal(true), commitSha: z.string(), removed: z.array(z.string()) }), 'Removed skill'), ...errors(400, 403, 404, 409, 502) },
  }), async (c: Context<AppEnv>) => {
    const projectId = c.req.param('projectId');
    if (!projectId) return c.json({ error: 'Not found' }, 404);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);
    for (const action of [PROJECT_ACTIONS.PROJECT_SKILL_WRITE, PROJECT_ACTIONS.PROJECT_AGENT_WRITE]) {
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, action);
    }
    const body = RemoveSkillSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Explicit confirmation of whole-folder removal is required' }, 400);
    const project = await withProjectGitAuth(loaded.row);
    try {
      await refreshMirror(project, true);
      const commit = await resolveBranchTip(project, project.defaultBranch);
      const manifest = await readManifest(project, { rethrowReadErrors: true });
      if (!manifest || manifest.commit !== commit || manifest.revision === undefined) {
        return c.json({ error: 'A readable committed manifest is required; refresh and retry' }, 409);
      }
      if (!validateManifest(manifest.raw, manifest.format).valid) {
        return c.json({ error: 'Repair invalid project configuration before removing a skill' }, 409);
      }
      let plan;
      try {
        plan = planSkillRemoval(manifest.raw, (await listRepoFiles(project, commit)).map((file) => file.path), body.data.folder);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      const validation = validateManifest(plan.raw, manifest.format);
      if (!validation.valid) return c.json({ error: 'Removal would leave invalid project configuration', issues: validation.issues }, 409);
      manifest.raw = plan.raw;
      const writes = manifestWrites(manifest);
      // An imported manifest inside the removed folder would leave dangling imports.
      if ([manifest.path, ...writes.alsoExpect.map((file) => file.path)].some((path) => path?.startsWith(`${body.data.folder}/`))) {
        return c.json({ error: 'Skill folder contains manifest configuration' }, 409);
      }
      const result = await commitMultipleFilesToBranch(project, {
        files: writes.files, deletes: plan.deletes, alsoExpect: writes.alsoExpect,
        branch: project.defaultBranch, expectedCommit: commit,
        expectedFileRevision: { path: manifest.path || loaded.row.manifestPath || 'kortix.yaml', sha: manifest.revision, candidatePaths: manifest.candidatePaths },
        message: `chore: remove project skill ${body.data.folder}`,
      });
      invalidateProjectResourceConfig(projectId);
      return c.json({ ok: true as const, commitSha: result.commitSha, removed: plan.deletes }, 200);
    } catch (error) {
      if (error instanceof GitFileRevisionConflictError || isRemotePushPolicyRejection(error)) {
        return c.json({ error: error.message }, 409);
      }
      // A disconnected repository needs a person to act: the global handler
      // answers the shared 409 that names the fix (KRTX-2979).
      if (hasCause(error, isRepositoryDisconnectedError)) throw error;
      // Git output can carry the remote URL, so the cause goes to the log only.
      logger.warn('[skills] remove failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: 'Could not remove the skill from the repository' }, 502);
    }
  });
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
    try {
      await readRepoFile(gitProject, path);
      // The file reads back: this slug is taken.
      return c.json(
        { error: `A skill named "${slug}" already exists`, code: 'skill_exists' },
        409,
      );
    } catch (err) {
      // Only a missing file means the slug is free. Any other read error is a
      // repo problem: failing open here would let a transient mirror error
      // turn the create into a silent overwrite of an existing skill.
      if (!isRepoFileNotFoundError(err)) {
        return c.json(
          {
            error: `Failed to read the project repo: ${(err as Error).message || String(err)}`,
            code: 'repo_read',
          },
          502,
        );
      }
      // Not there — the normal case.
    }

    try {
      const content = renderSkillMarkdown(skill);
      const message = `feat: add skill ${slug}`;
      await refreshMirror(gitProject, true);
      const commit = await resolveBranchTip(gitProject, gitProject.defaultBranch);
      const manifest = await readManifest(gitProject, { rethrowReadErrors: true });
      if (!manifest || manifest.schemaVersion < 3) {
        await commitFileToBranch(gitProject, { path, content, message, branch: loaded.row.defaultBranch });
      } else {
        // kortix_version 3 lists a skill only when kortix.yaml registers it
        // (`skills.<name>: <folder>`), so the SKILL.md and its registration land
        // in one commit (KRTX-2543). Same guards as removal.
        if (manifest.commit !== commit || manifest.revision === undefined) {
          return c.json({ error: 'A readable committed manifest is required; refresh and retry' }, 409);
        }
        if (!validateManifest(manifest.raw, manifest.format).valid) {
          return c.json({ error: 'Repair invalid project configuration before adding a skill', code: 'manifest_invalid' }, 409);
        }
        const registry = manifest.raw.skills;
        const skills =
          registry && typeof registry === 'object' && !Array.isArray(registry) ? (registry as Record<string, unknown>) : {};
        if (slug in skills) {
          return c.json({ error: `A skill named "${slug}" already exists`, code: 'skill_exists' }, 409);
        }
        manifest.raw = { ...manifest.raw, skills: { ...skills, [slug]: `skills/${slug}` } };
        const validation = validateManifest(manifest.raw, manifest.format);
        if (!validation.valid) {
          return c.json({ error: 'The skill would leave invalid project configuration', code: 'manifest_invalid', issues: validation.issues }, 409);
        }
        const writes = manifestWrites(manifest);
        await commitMultipleFilesToBranch(gitProject, {
          files: [...writes.files, { path, content }],
          alsoExpect: writes.alsoExpect,
          branch: gitProject.defaultBranch,
          expectedCommit: commit,
          expectedFileRevision: {
            path: manifest.path || loaded.row.manifestPath || 'kortix.yaml',
            sha: manifest.revision,
            candidatePaths: manifest.candidatePaths,
          },
          message,
        });
      }
      invalidateProjectResourceConfig(projectId);
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
}
