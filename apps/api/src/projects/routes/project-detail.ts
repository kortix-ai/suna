import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { type SQL, eq, sql } from 'drizzle-orm';
/** One project: read, detail, and update. */
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json, lenientBody } from '../../openapi';
import { db } from '../../shared/db';
import { readJsonObject } from '../../shared/http-body';
import { listRepoFiles, loadProjectConfig } from '../git';
import { savedProjectConfig } from '../config-summary/service';
import { disconnectedProjectConfig } from '../git/config';
import { isRepositoryDisconnectedError } from '../../shared/repository-health';
import { allowStaleMirrorReads } from '../git/mirror';
import {
  agentSessionWorkspaceAllowsRepository,
  assertAgentSessionWorkspaceAllowsRepository,
  assertProjectCapability,
  loadProjectForUser,
  projectCapabilityAllowed,
} from '../lib/access';
import { ProjectSchema, projectsApp } from '../lib/app';
import { applyDetailCapabilityFilter } from '../lib/detail-capability-filter';
import { getProjectGitConnection, withProjectGitAuth } from '../lib/git';
import { MANIFEST_PROJECT_NAME_KEY, commitProjectName } from '../lib/manifest-project-name';
import { renameAccountOfSoleProject } from '../lib/workspace-name';
import { MANIFEST_SYNTAX_ISSUE_PATH } from '@kortix/manifest-schema';
import { addMyKortixAgent, projectBuiltinAgents } from '../lib/my-kortix-agent';
import { normalizeProjectGlyph } from '../lib/project-glyph';
import { normalizeProjectIcon } from '../lib/project-icon';
import { denierFromConfig, filterConfigResourcesForUser } from '../lib/project-resources';
import { featureFlagsEnvValue } from '../lib/feature-flag-env';
import { managedSkillFeatureFlag } from '../../skills/catalog';
import {
  normalizeString,
  serializeProject,
  serializeProjectGitConnection,
} from '../lib/serializers';
import { workspaceIdParam } from '../../shared/route-params';
import type { AppEnv } from '../../types';
import { metadataMerge, projectsView, updateProjectRows, updateProjectRowsReturning, type ProjectRowInsert, type ProjectRowSet } from '../../workspaces/rows';

/** `GET /:projectId/detail`: the project plus its git connection and the
 *  manifest summary the settings pages read. */
const ProjectDetailSchema = z
  .object({
    project: ProjectSchema,
    git_connection: z.record(z.string(), z.unknown()).nullable(),
    config: z.record(z.string(), z.unknown()),
    file_count: z.number().openapi({
      deprecated: true,
      description: 'Deprecated: use `GET /projects/{projectId}/files`.',
    }),
    files: z.array(z.record(z.string(), z.unknown())).openapi({
      deprecated: true,
      description: 'Deprecated: the first 300 repository paths only. Use `GET /projects/{projectId}/files?path=<folder>`.',
    }),
  })
  .openapi('ProjectDetail');

/**
 * One project record as the caller may see it: `null` when the project does
 * not exist or the caller may not read it. A session without repository
 * access gets the record minus every repository field (its CLI needs the
 * flags). Stamps `last_opened_at` behind the answer. `GET /v1/projects/:id`
 * and `GET /v1/workspaces/:id` both read through here.
 */
export async function readProjectRecord(c: Context<AppEnv>, projectId: string) {
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return null;
  const repositoryVisible = await agentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);

  // The open stamp is a page-view counter: the project selector and the
  // command palette sort by it, and nothing in this request reads it back.
  // Awaiting it put a row-lock write on the hottest read route; under DB
  // contention (prod 2026-09-29, KRTX-470) that commit wait landed on every
  // page view's latency. The response now answers first and the write lands
  // behind it — the same rule the audit-pool learning fixed for
  // POST /internal/gateway/trace (KRTX-609).
  void updateProjectRows(eq(projectsView.projectId, projectId), { lastOpenedAt: new Date(), updatedAt: new Date() })
    .catch((error: unknown) => {
      console.warn('[projects] last-opened stamp failed', {
        projectId,
        reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    });

  const project = serializeProject(loaded.row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  });
  return {
    loaded,
    project: repositoryVisible
      ? project
      : { ...project, repo_url: '', git_origin_url: '', default_branch: '', manifest_path: '' },
  };
}

/** `projects.secret_default_strategy`: how a secret with no strategy of its own is delivered. */
const SECRET_STRATEGIES = ['runtime', 'egress', 'broker', 'denied'] as const satisfies readonly NonNullable<
  ProjectRowInsert['secretDefaultStrategy']
>[];

export function registerProjectDetailRoutes(): void {
  // GET /v1/projects/:projectId

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}',
      tags: ['projects'],
      summary: 'Get a project',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
      responses: {
        200: json(ProjectSchema, 'The project'),
        ...errors(404),
      },
    }),
    async (c) => {
      const requestedProjectId = workspaceIdParam(c);
      const projectId = requestedProjectId === 'current'
        ? c.get('tokenProjectId')
        : requestedProjectId;
      if (!projectId) return c.json({ error: 'Not found' }, 404);
      const record = await readProjectRecord(c, projectId);
      if (!record) return c.json({ error: 'Not found' }, 404);
      return c.json(record.project);
    },
  );

  // GET /v1/projects/:projectId/detail

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/detail',
      tags: ['projects'],
      summary: 'Get project detail with configuration',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
      },
      responses: {
        200: json(ProjectDetailSchema, 'Project detail'),
        ...errors(404),
      },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertAgentSessionWorkspaceAllowsRepository(c, loaded.row.accountId, projectId);
      // A page view: serve the warm git mirror, refresh it behind the response.
      allowStaleMirrorReads();
      const ref = loaded.row.defaultBranch;

      // The saved summary of the default branch: no git on this path
      // (`config-summary/service.ts`). A moved tip rebuilds it behind the response.
      const saved = await savedProjectConfig(loaded.row);
      let files: Awaited<ReturnType<typeof listRepoFiles>> = [];
      let rawConfig: Awaited<ReturnType<typeof loadProjectConfig>>;
      const listLive = async (gitProject: Awaited<ReturnType<typeof withProjectGitAuth>>) => {
        try {
          return await listRepoFiles(gitProject, ref);
        } catch (error) {
          console.warn('[projects] repo detail listing unavailable', {
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          c.header('X-Kortix-Repo-Status', 'unavailable');
          return [];
        }
      };
      if (saved) {
        c.header('X-Kortix-Config-Source', `snapshot; commit=${saved.sourceCommit}`);
        rawConfig = saved.config;
        // Past the stored path cap the list comes from git, as before.
        if (saved.filesComplete) files = saved.files;
        else {
          const gitProject = await withProjectGitAuth(loaded.row).catch((error) => {
            if (isRepositoryDisconnectedError(error)) return null;
            throw error;
          });
          if (gitProject) files = await listLive(gitProject);
          else c.header('X-Kortix-Repo-Status', 'disconnected');
        }
      } else {
        c.header('X-Kortix-Config-Source', 'live');
        // A disconnected repository still renders the project shell: no files,
        // and a config whose `manifest_version.unknown_reason` names the cause.
        // `git_connection` below carries the reason and the fix.
        const gitProject = await withProjectGitAuth(loaded.row).catch((error) => {
          if (isRepositoryDisconnectedError(error)) return null;
          throw error;
        });
        if (!gitProject) {
          c.header('X-Kortix-Repo-Status', 'disconnected');
        } else {
          files = await listLive(gitProject);
        }
        rawConfig = gitProject ? await loadProjectConfig(gitProject, files) : disconnectedProjectConfig();
      }
      // Per-resource scoping: hide agents/skills this member isn't granted (owner/
      // admins/SAs see everything). No-op when the project has no resource grants.
      const denierCtx = {
        userId: loaded.userId,
        accountId: loaded.row.accountId,
        projectId,
        actingTokenId: (c.get('iamTokenId') as string | undefined) ?? undefined,
      };
      const filteredConfig = await filterConfigResourcesForUser(rawConfig, denierCtx);
      // My Kortix (slug `mykortix`) is listed first when kortix.yaml sets
      // `builtin_agents.my_kortix: true`. Off: the config is exactly the
      // repo-declared surface. A kortix.yaml that is not YAML runs the last
      // version that parses (`rawConfig.manifest`); with none it is repair
      // mode, where My Kortix runs so it can be fixed (`loadProjectAgents`).
      const repairMode =
        rawConfig.manifest_health.issues.some((issue) => issue.path === MANIFEST_SYNTAX_ISSUE_PATH) &&
        Object.keys(rawConfig.manifest).length === 0;
      const builtinAgents = repairMode ? { my_kortix: true } : projectBuiltinAgents(rawConfig.manifest);
      const withAgents = {
        ...(builtinAgents.my_kortix ? addMyKortixAgent(filteredConfig) : filteredConfig),
        builtin_agents: builtinAgents,
      };
      // A Kortix skill behind a feature flag is listed only while the flag is on: the box does
      // not have it either (feature-flag-env.ts → kortixd).
      const enabledFlags = new Set(featureFlagsEnvValue(loaded.row.metadata).split(','));
      const config = {
        ...withAgents,
        skills: withAgents.skills.filter((skill) => {
          const flag = managedSkillFeatureFlag(skill.name);
          return !flag || enabledFlags.has(flag);
        }),
      };
      // …and hide the raw FILES of those resources from the file list (visibility
      // isolation). Reuses the config already loaded — no extra git round-trip.
      const denier = await denierFromConfig(rawConfig, denierCtx);
      const visibleFiles = denier ? files.filter((f) => !denier.isDenied(f.path)) : files;
      // Per-CAPABILITY filtering (distinct from the per-resource grants above): the
      // /detail bundle serves several read surfaces behind ONE project.read floor, so
      // gate each section on its own leaf. A plain `member` keeps the config sections
      // it can read but NOT the file list (member lacks project.file.read), and a
      // custom role that unchecks e.g. project.skill.read gets an empty skills
      // section — all WITHOUT 403-ing the whole workspace load (which loadProjectForUser
      // deliberately gates only on project.read so the shell renders for every member).
      const [canFiles, canAgents, canSkills, canCommands] = await Promise.all([
        projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_FILE_READ,
        ),
        projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_AGENT_READ,
        ),
        projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_SKILL_READ,
        ),
        projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_COMMAND_READ,
        ),
      ]);
      const gated = applyDetailCapabilityFilter(config, visibleFiles, {
        canFiles,
        canAgents,
        canSkills,
        canCommands,
      });
      // The parsed kortix.yaml stays on the server: no client reads it, and on
      // a large project it was 84 KB of a 208 KB body that every project page
      // loads (2026-11-04). The summary below, and `manifest_raw` for the
      // agent editor, are what the readers use.
      const { manifest: _parsedManifest, ...wireConfig } = gated.config;
      return c.json({
        project: serializeProject(loaded.row, {
          projectRole: loaded.projectRole,
          effectiveRole: loaded.effectiveRole,
        }),
        git_connection: serializeProjectGitConnection(await getProjectGitConnection(projectId)),
        config: wireConfig,
        file_count: gated.file_count,
        files: gated.files,
      });
    },
  );

  // PATCH /v1/projects/:projectId

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}',
      tags: ['projects'],
      summary: 'Update project name or settings',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            name: z.string().optional().openapi({ description: 'New project name.' }),
            default_branch: z.string().optional().openapi({ description: 'New default branch.' }),
            manifest_path: z.string().optional().openapi({ description: 'New manifest path.' }),
            icon: z.string().optional().openapi({ description: 'Project icon name. null clears it.' }),
            icon_glyph: z.string().optional().openapi({ description: 'Project icon glyph. null clears it.' }),
            secret_default_strategy: z.enum(SECRET_STRATEGIES).optional().openapi({ description: 'How a secret with no strategy of its own is delivered to sessions.' }),
          }) } } },
      },
      responses: {
        200: json(ProjectSchema, 'The updated project'),
        ...errors(400, 404, 409),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: the shared handler answers a plain Response.
    async (c) => patchProjectRecord(c) as any,
  );
}

/**
 * `PATCH /v1/projects/:id`, and `PATCH /v1/workspaces/:id` once the canonical
 * route has refused the workspace settings keys: name, icon, default branch,
 * manifest path and the secret delivery default.
 */
export async function patchProjectRecord(c: Context<AppEnv>): Promise<Response> {
  const projectId = workspaceIdParam(c);
  const body = await readJsonObject(c);
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Editing project config (name / default_branch / manifest_path) is a
  // customize-write capability. manifest_path is especially sensitive: it
  // selects which kortix.yaml drives per-agent env scoping, so a custom role
  // can withhold it and a scoped agent must hold it (central fold).
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE,
  );

  const updates: ProjectRowSet = { updatedAt: new Date() };
  const name = normalizeString(body.name);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch);
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath);

  if (name) updates.name = name;
  if (defaultBranch) updates.defaultBranch = defaultBranch;
  if (manifestPath) updates.manifestPath = manifestPath;
  if ('secret_default_strategy' in body) {
    const strategy = body.secret_default_strategy;
    if (typeof strategy !== 'string' || !(SECRET_STRATEGIES as readonly string[]).includes(strategy)) {
      return c.json({ error: `secret_default_strategy must be one of ${SECRET_STRATEGIES.join(', ')}` }, 400);
    }
    // The default decides how every unconfigured secret reaches a session:
    // the secret-write capability, on top of the settings write above.
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
    updates.secretDefaultStrategy = strategy as (typeof SECRET_STRATEGIES)[number];
  }

  // `icon` and `icon_glyph` are the two fields here where "absent" and "null"
  // mean different things, and where a malformed value must be distinguished
  // from an explicit removal. Both normalizers collapse invalid input AND an
  // explicit null to `null`, so only the request BODY — not the normalizer's
  // return value — can tell those apart. Resolution is by VALIDITY, not by
  // key presence, so a PATCH agrees with the three create paths (provision /
  // create-repo / link-repository) on every shared input, including a body
  // that carries both keys:
  //
  //   neither key present                 → no metadata write; untouched
  //   icon_glyph valid                    → merge { icon_glyph }, delete `icon`
  //   icon_glyph invalid, icon valid      → merge { icon },       delete `icon_glyph`
  //   icon valid alone                    → merge { icon },       delete `icon_glyph`
  //   icon_glyph invalid, icon invalid/absent, icon_glyph: null   → delete `icon_glyph`
  //   icon invalid/absent, icon_glyph invalid/absent, icon: null  → delete `icon`
  //   icon: null AND icon_glyph: null (both explicit)             → delete BOTH keys
  //   icon invalid alone (no valid glyph, no explicit null)       → no metadata write
  //   both invalid, neither explicitly null                       → no metadata write
  //
  // A malformed value must never be able to wipe a choice the user made — only
  // an explicit `null` on a key clears THAT key. Sending both keys `null` in
  // the same request reads as "clear the icon entirely" and clears both,
  // rather than picking one key to privilege for deletion.
  //
  // THE INVARIANT: a project shows one icon, so writing either key deletes the
  // other in the SAME statement — `metadataMerge` emits
  // `(coalesce(metadata,'{}') - 'icon') || '{"icon_glyph":…}'::jsonb`, one
  // expression under the row's own lock. Enforcing it here rather than in the
  // modal means every client gets the rule without implementing it.
  //
  // A valid `icon_glyph` always wins over `icon` (checked first below), same
  // as the create paths: a request carrying both valid values resolves to the
  // glyph, and the emoji is dropped.
  const iconGlyphPresent = 'icon_glyph' in body;
  const iconGlyph = iconGlyphPresent ? normalizeProjectGlyph(body.icon_glyph) : null;
  const iconPresent = 'icon' in body;
  const icon = iconPresent ? normalizeProjectIcon(body.icon) : null;

  let metadataExpr: SQL | undefined;
  if (iconGlyph) {
    metadataExpr = metadataMerge({ icon_glyph: iconGlyph }, ['icon']);
  } else if (icon) {
    metadataExpr = metadataMerge({ icon }, ['icon_glyph']);
  } else {
    // Neither side resolved to a value worth storing. Delete only the keys
    // the caller EXPLICITLY nulled — a key that's absent or merely malformed
    // is left untouched, per the invariant above.
    const deleteKeys: string[] = [];
    if (iconGlyphPresent && body.icon_glyph === null) deleteKeys.push('icon_glyph');
    if (iconPresent && body.icon === null) deleteKeys.push('icon');
    if (deleteKeys.length > 0) metadataExpr = metadataMerge({}, deleteKeys);
  }

  // kortix.yaml owns project.name: commit the rename first; a refused commit renames nothing.
  if (name && name !== loaded.row.name) {
    const declared = await commitProjectName(loaded.row, name);
    if (!declared.ok) return c.json({ error: declared.error, code: declared.code ?? 'manifest_write_failed' }, declared.status as 400 | 409);
    metadataExpr = metadataExpr
      ? sql`${metadataExpr} || ${JSON.stringify({ [MANIFEST_PROJECT_NAME_KEY]: name })}::jsonb`
      : metadataMerge({ [MANIFEST_PROJECT_NAME_KEY]: name });
  }

  if (metadataExpr) updates.metadata = metadataExpr;
  const [row] = await updateProjectRowsReturning(eq(projectsView.projectId, projectId), updates);

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  // Workspace name = account name = project name: the account's only
  // project renames the account with it.
  if (name && name !== loaded.row.name) await renameAccountOfSoleProject(row, name);
  return c.json(
    serializeProject(row, {
      projectRole: loaded.projectRole,
      effectiveRole: loaded.effectiveRole,
    }),
  );
}
