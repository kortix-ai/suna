/**
 * Subproject CRUD — one `kortix-<slug>.yaml` per subproject.
 *
 * The manifest is the source of truth, so every write here is one git commit,
 * exactly like the trigger routes next door (`routes/r4.ts`): read the manifest
 * for edit, mutate it in memory, commit with a compare-and-swap retry.
 *
 * Gates:
 *  - read  → `loadProjectForUser(read)` + `project.read`, then the per-object
 *            fold (`lib/subproject-access.ts`), so a member sees only the
 *            subprojects granted to them and an ungranted one is a 404.
 *  - write → `loadProjectForUser(manage)` + `project.customize.write` — the
 *            manifest-editing leaf, manager tier. No new permission leaf: the
 *            permission catalog is DB-driven.
 */

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { PROJECT_ACTIONS } from '../../iam';
import { mutateManifestWithRetry } from '../../connectors/manifest-mutation';
import { auth, errors, json } from '../../openapi';
import {
  assertProjectCapability,
  loadProjectForUser,
  projectCapabilityAllowed,
} from '../lib/access';
import { AnyObject, SubprojectSchema, SubprojectsResponseSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { callerKortixSessionId } from '../lib/caller-session';
import { normalizeString, readBody, type ProjectRow } from '../lib/serializers';
import { loadProjectSessionInventory } from '../lib/session-list';
import { accessibleSubprojectSlugs, subprojectViewerAccess } from '../lib/subproject-access';
import { serializeManifestObject } from '@kortix/manifest-schema';
import { commitRepoChanges, commitRepoFile, slugify } from '../lib/triggers';
import { loadProjectAgents } from '../agents';
import type { GitBackedProject } from '../git';
// From the module, not the `../git` barrel: tests that mock the barrel with a
// fixed export list must keep loading this route.
import { readRepoFileRevision } from '../git/files';
import {
  loadProjectSubprojects,
  stripSubprojectFromTriggers,
  subprojectPathFor,
  subprojectSpecToFileEntry,
  usableAgentNames,
  type SubprojectSessionsMode,
  type SubprojectSpec,
} from '../subprojects';
import type { ParsedManifest } from '../triggers';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SESSIONS_MODES: readonly SubprojectSessionsMode[] = ['private', 'shared'];
/** What a create/update body may carry. `slug` is create-only and immutable —
 *  on a PATCH it lands here as a no-op, not as a rename. */
const SUBPROJECT_BODY_KEYS = ['name', 'slug', 'description', 'agent', 'sessions'];

const ParamsWithSlug = z.object({ projectId: z.string(), slug: z.string() });

type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

/** Everything a response needs beyond the spec itself. */
interface SubprojectContext {
  sessionCounts: Map<string, number>;
  triggerCounts: Map<string, number>;
  canManage: boolean;
}

function serializeSubproject(spec: SubprojectSpec, ctx: SubprojectContext) {
  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    agent: spec.agent,
    sessions: spec.sessions,
    path: spec.path,
    agents: spec.agents,
    session_count: ctx.sessionCounts.get(spec.slug) ?? 0,
    trigger_count: ctx.triggerCounts.get(spec.slug) ?? 0,
    can_manage: ctx.canManage,
  };
}

/**
 * Load the manifest for reading, plus the counts the wire shape carries.
 *
 * `session_count` reuses `loadProjectSessionInventory` — the SAME fold the
 * session list uses — rather than a bespoke count, so "sessions the caller can
 * see" cannot drift between the number on the card and the rows on the page.
 */
async function loadSubprojectView(
  c: Context,
  loaded: Loaded,
  projectId: string,
): Promise<{
  specs: SubprojectSpec[];
  errors: Array<{ slug: string; path: string; error: string }>;
  ctx: SubprojectContext;
}> {
  const gitProject = await withProjectGitAuth(loaded.row);
  const { loadProjectTriggers } = await import('../triggers');
  const [declared, triggers, canManage] = await Promise.all([
    loadProjectSubprojects(gitProject),
    loadProjectTriggers(gitProject),
    projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    ),
  ]);

  const accessible = new Set(
    await accessibleSubprojectSlugs(
      c,
      loaded,
      projectId,
      declared.specs.map((s) => s.slug),
    ),
  );
  const specs = declared.specs.filter((s) => accessible.has(s.slug));

  const triggerCounts = new Map<string, number>();
  for (const spec of triggers.specs) {
    if (!spec.subproject) continue;
    triggerCounts.set(spec.subproject, (triggerCounts.get(spec.subproject) ?? 0) + 1);
  }

  const sessionCounts = new Map<string, number>();
  if (specs.length > 0) {
    const inventory = await loadProjectSessionInventory({
      projectId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
      effectiveRole: loaded.effectiveRole,
      scope: 'visible',
      boundCredentialSessionId: callerKortixSessionId(c),
      loadSubprojectAccess: (slugs) => subprojectViewerAccess(c, loaded, projectId, slugs),
      probeManageCapability: () =>
        projectCapabilityAllowed(
          c,
          loaded.userId,
          loaded.row.accountId,
          projectId,
          PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
        ),
    });
    for (const item of inventory.items) {
      if (!item.row.subproject) continue;
      sessionCounts.set(item.row.subproject, (sessionCounts.get(item.row.subproject) ?? 0) + 1);
    }
  }

  return { specs, errors: declared.errors, ctx: { sessionCounts, triggerCounts, canManage } };
}

/** Parse the create/update body onto a base spec. Returns the error string the
 *  route should 400 with, or the merged spec. `existing` is null on create. */
function mergeSubprojectBody(
  body: Record<string, unknown>,
  existing: SubprojectSpec | null,
  slug: string,
  manifestPath: string,
  declaredAgents: readonly string[],
): SubprojectSpec | { error: string } {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  // Refuse what this version does not have rather than swallowing it. A client
  // still sending `instructions` or `context` (both dropped 2026-09-07) has to
  // learn that the write does nothing, not lose it silently.
  const unknown = Object.keys(body).find((key) => !SUBPROJECT_BODY_KEYS.includes(key));
  if (unknown) {
    return { error: `"${unknown}" is not a subproject field (allowed: ${SUBPROJECT_BODY_KEYS.join(', ')})` };
  }
  const spec: SubprojectSpec = existing
    ? { ...existing }
    : {
        slug,
        path: subprojectPathFor(manifestPath, slug),
        name: slug,
        description: null,
        agent: null,
        sessions: 'private',
        agents: [],
        ownedAgents: [],
        references: [],
        agentsRaw: null,
      };
  spec.slug = slug;
  spec.path = subprojectPathFor(manifestPath, slug);

  if (has('name')) {
    const name = normalizeString(body.name);
    if (!name) return { error: 'name must be a non-empty string' };
    spec.name = name;
  }
  // `null` clears an optional field; omitting it leaves it alone.
  if (has('description')) spec.description = normalizeString(body.description);
  if (has('agent')) {
    const agent = normalizeString(body.agent);
    if (agent && !declaredAgents.includes(agent)) {
      return {
        error: `agent "${agent}" is not usable in this subproject — declare it in the root manifest, in kortix-${slug}.yaml, or reference it there with { from: <slug> }`,
      };
    }
    spec.agent = agent;
  }
  if (has('sessions')) {
    const sessions = normalizeString(body.sessions);
    if (!sessions || !(SESSIONS_MODES as readonly string[]).includes(sessions)) {
      return { error: 'sessions must be "private" or "shared"' };
    }
    spec.sessions = sessions as SubprojectSessionsMode;
  }
  return spec;
}

/** The agent names a subproject may set as its `agent:` — the globals plus
 *  the ones it owns or references (spec 2026-09-06 §2). On create, globals. */
async function usableAgentsFor(
  gitProject: GitBackedProject,
  existing: SubprojectSpec | null,
): Promise<string[]> {
  return usableAgentNames(await loadProjectAgents(gitProject), existing);
}

/** Where the root manifest lives — the directory subproject files go in. A
 *  project with no manifest yet uses its configured path, like every other
 *  synthesized-manifest reader. */
async function rootManifestPath(gitProject: GitBackedProject): Promise<string> {
  const { readManifest } = await import('../triggers');
  const manifest = await readManifest(gitProject);
  return manifest?.path ?? gitProject.manifestPath ?? 'kortix.yaml';
}

function serializeSubprojectFile(spec: SubprojectSpec): string {
  return serializeManifestObject(subprojectSpecToFileEntry(spec), 'yaml');
}

/** Rewrite one subproject's file with compare-and-swap on its blob: a lost
 *  race is a 409, never a silent overwrite of someone else's edit. */
async function writeSubprojectFile(
  row: ProjectRow,
  gitProject: GitBackedProject,
  spec: SubprojectSpec,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const revision = await readRepoFileRevision(gitProject, spec.path);
  return commitRepoFile(row, spec.path, serializeSubprojectFile(spec), message, revision);
}

// ─── GET /v1/projects/:projectId/subprojects ────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/subprojects',
    tags: ['subprojects'],
    summary: 'GET /:projectId/subprojects',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(SubprojectsResponseSchema, "The project's accessible subprojects"),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_READ,
    );

    const view = await loadSubprojectView(c, loaded, projectId);
    return c.json({
      subprojects: view.specs.map((spec) => serializeSubproject(spec, view.ctx)),
      errors: view.errors,
    });
  },
);

// ─── POST /v1/projects/:projectId/subprojects ───────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/subprojects',
    tags: ['subprojects'],
    summary: 'POST /:projectId/subprojects',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(SubprojectSchema, 'The created subproject'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );

    const name = normalizeString(body.name);
    if (!name) return c.json({ error: 'name is required' }, 400);
    const slug = normalizeString(body.slug) ?? slugify(name);
    if (!SLUG_RE.test(slug)) {
      return c.json(
        { error: `Invalid slug "${slug}" — use lowercase letters, digits, dashes, underscores` },
        400,
      );
    }

    const gitProject = await withProjectGitAuth(loaded.row);
    const [declared, rootPath] = await Promise.all([
      loadProjectSubprojects(gitProject),
      rootManifestPath(gitProject),
    ]);
    const filePath = subprojectPathFor(rootPath, slug);
    // A file that exists but failed to parse is still that slug's file.
    if (
      declared.specs.some((s) => s.slug === slug) ||
      (await readRepoFileRevision(gitProject, filePath)) !== null
    ) {
      return c.json(
        {
          error: `A subproject with slug "${slug}" already exists. Pick a different name.`,
          code: 'SUBPROJECT_SLUG_TAKEN',
        },
        409,
      );
    }
    const usable = await usableAgentsFor(gitProject, null);
    const merged = mergeSubprojectBody({ ...body, name }, null, slug, rootPath, usable);
    if ('error' in merged) return c.json({ error: merged.error }, 400);
    const committed = await commitRepoFile(
      loaded.row,
      filePath,
      serializeSubprojectFile(merged),
      `feat(subprojects): add ${slug}`,
    );
    if ('error' in committed) {
      return c.json({ error: committed.error }, committed.status as 400 | 409 | 502);
    }
    const created: SubprojectSpec = merged;
    // A brand-new subproject has no sessions and no triggers yet, and the
    // author just cleared `project.customize.write`.
    return c.json(
      serializeSubproject(created, {
        sessionCounts: new Map(),
        triggerCounts: new Map(),
        canManage: true,
      }),
      201,
    );
  },
);

// ─── GET /v1/projects/:projectId/subprojects/:slug ──────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/subprojects/{slug}',
    tags: ['subprojects'],
    summary: 'GET /:projectId/subprojects/:slug',
    ...auth,
    request: { params: ParamsWithSlug },
    responses: {
      200: json(SubprojectSchema, 'The subproject'),
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_READ,
    );

    const view = await loadSubprojectView(c, loaded, projectId);
    const spec = view.specs.find((s) => s.slug === slug);
    // Undeclared and inaccessible are the SAME answer: a member without the
    // grant must not be able to probe which subprojects exist.
    if (!spec) return c.json({ error: 'Not found' }, 404);
    return c.json(serializeSubproject(spec, view.ctx));
  },
);

// ─── PATCH /v1/projects/:projectId/subprojects/:slug ────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/subprojects/{slug}',
    tags: ['subprojects'],
    summary: 'PATCH /:projectId/subprojects/:slug',
    ...auth,
    request: {
      params: ParamsWithSlug,
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(SubprojectSchema, 'The updated subproject'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );

    const gitProject = await withProjectGitAuth(loaded.row);
    const [declared, rootPath] = await Promise.all([
      loadProjectSubprojects(gitProject),
      rootManifestPath(gitProject),
    ]);
    const current = declared.specs.find((s) => s.slug === slug);
    if (!current) return c.json({ error: 'Not found' }, 404);
    // An empty body is a no-op: no commit, the current shape comes back.
    if (Object.keys(body).length > 0) {
      const usable = await usableAgentsFor(gitProject, current);
      const merged = mergeSubprojectBody(body, current, slug, rootPath, usable);
      if ('error' in merged) return c.json({ error: merged.error }, 400);
      const written = await writeSubprojectFile(
        loaded.row,
        gitProject,
        merged,
        `chore(subprojects): update ${slug}`,
      );
      if ('error' in written) {
        return c.json({ error: written.error }, written.status as 400 | 409 | 502);
      }
    }
    return c.json(await readOne(c, loaded, projectId, slug));
  },
);

// ─── DELETE /v1/projects/:projectId/subprojects/:slug ───────────────────────

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/subprojects/{slug}',
    tags: ['subprojects'],
    summary: 'DELETE /:projectId/subprojects/:slug',
    ...auth,
    request: { params: ParamsWithSlug },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Deleted'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );

    const gitProject = await withProjectGitAuth(loaded.row);
    const declared = await loadProjectSubprojects(gitProject);
    const current = declared.specs.find((s) => s.slug === slug);
    if (!current) return c.json({ error: 'Not found' }, 404);
    // Two always-valid commits (spec 2026-09-06 §4): first detach every
    // trigger naming this subproject — a trigger pointing at a missing one
    // fails the set validator — then remove the file.
    const detached = await mutateManifestWithRetry(
      loaded.row,
      `subproject ${slug} was being deleted`,
      (manifest: ParsedManifest) => {
        const before = JSON.stringify(manifest.raw.triggers ?? null);
        const next = stripSubprojectFromTriggers(manifest, slug);
        if (JSON.stringify(next.raw.triggers ?? null) === before) {
          return { ok: true as const, commitMessage: null };
        }
        manifest.raw = next.raw;
        return {
          ok: true as const,
          commitMessage: `chore(subprojects): detach ${slug} from its triggers`,
        };
      },
    );
    if (!detached.ok) {
      return c.json({ error: detached.error }, detached.status as 400 | 409 | 502);
    }
    const removed = await commitRepoChanges(loaded.row, {
      deletes: [current.path],
      message: `chore(subprojects): delete ${slug}`,
    });
    if ('error' in removed) {
      return c.json({ error: removed.error }, removed.status as 400 | 409 | 502);
    }
    return c.json({ ok: true });
  },
);

/** Re-read one subproject after a write, for the response body. */
async function readOne(c: Context, loaded: Loaded, projectId: string, slug: string) {
  const view = await loadSubprojectView(c, loaded, projectId);
  const spec = view.specs.find((s) => s.slug === slug);
  if (!spec) throw new Error(`subproject ${slug} vanished after a successful write`);
  return serializeSubproject(spec, view.ctx);
}
