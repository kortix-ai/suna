/** One project: read, detail, and update. */
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { listRepoFiles, loadProjectConfig } from '../git';
import { createRoute, z } from '@hono/zod-openapi';
import { projects } from '@kortix/db';
import { eq, type SQL } from 'drizzle-orm';
import {
  assertAgentSessionWorkspaceAllowsRepository,
  assertProjectCapability,
  loadProjectForUser,
  projectCapabilityAllowed,
} from '../lib/access';
import { metadataMerge } from '../lib/metadata-merge';
import { normalizeProjectIcon } from '../lib/project-icon';
import { normalizeProjectGlyph } from '../lib/project-glyph';
import { applyDetailCapabilityFilter } from '../lib/detail-capability-filter';
import { denierFromConfig, filterConfigResourcesForUser } from '../lib/project-resources';
import { AnyObject, ProjectSchema, projectsApp } from '../lib/app';
import { getProjectGitConnection, withProjectGitAuth } from '../lib/git';
import {
  normalizeString,
  serializeProject,
  serializeProjectGitConnection,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { addPlatformMetaAgent } from '../lib/platform-meta-agent';

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
  async (c) => {
  const projectId = c.req.param('projectId');

  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertAgentSessionWorkspaceAllowsRepository(
    c,
    loaded.row.accountId,
    projectId,
  );

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
  await assertAgentSessionWorkspaceAllowsRepository(
    c,
    loaded.row.accountId,
    projectId,
  );

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
  const filteredConfig = await filterConfigResourcesForUser(rawConfig, denierCtx);
  // The platform coordinator appears in the agent list (and becomes the
  // default) only for projects that opted into the `meta_agent` experimental
  // feature. Flag off: the config is exactly the repo-declared surface.
  const config = resolveFeatureFlag(loaded.row.metadata, 'meta_agent')
    ? addPlatformMetaAgent(filteredConfig)
    : filteredConfig;
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
  const [canFiles, canAgents, canSkills, canCommands, canCustomize] = await Promise.all([
    projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_FILE_READ),
    projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_AGENT_READ),
    projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SKILL_READ),
    projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_COMMAND_READ),
    projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ),
  ]);
  const gated = applyDetailCapabilityFilter(config, visibleFiles, {
    canFiles,
    canAgents,
    canSkills,
    canCommands,
    canCustomize,
  });
  return c.json({
    project: serializeProject(loaded.row, {
      projectRole: loaded.projectRole,
      effectiveRole: loaded.effectiveRole,
    }),
    git_connection: serializeProjectGitConnection(await getProjectGitConnection(projectId)),
    config: gated.config,
    file_count: gated.file_count,
    files: gated.files,
  });
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
  const body = await readJsonObject(c);
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Editing project config (name / default_branch / manifest_path) is a
  // customize-write capability. manifest_path is especially sensitive: it
  // selects which kortix.yaml drives per-agent env scoping, so a custom role
  // can withhold it and a scoped agent must hold it (central fold).
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  const name = normalizeString(body.name);
  const defaultBranch = normalizeString(body.default_branch ?? body.defaultBranch);
  const manifestPath = normalizeString(body.manifest_path ?? body.manifestPath);

  if (name) updates.name = name;
  if (defaultBranch) updates.defaultBranch = defaultBranch;
  if (manifestPath) updates.manifestPath = manifestPath;

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

  const [row] = await db
    .update(projects)
    .set({
      ...updates,
      // Spread rather than assigned into `updates`: that object is typed
      // `Partial<$inferInsert>`, which has no room for a SQL expression, while
      // Drizzle's own `.set()` input accepts one per column.
      ...(metadataExpr ? { metadata: metadataExpr } : {}),
    })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);
