/**
 * Space CRUD — every space is a `spaces.<slug>` block of the root manifest.
 *
 * The manifest is the source of truth, so every write here is one git commit,
 * exactly like the trigger routes next door (`routes/r4.ts`): read the manifest
 * for edit, mutate it in memory, commit with a compare-and-swap retry.
 *
 * Gates:
 *  - read  → `loadProjectForUser(read)` + `project.read`, then the per-object
 *            fold (`lib/space-access.ts`), so a member sees only the
 *            spaces granted to them and an ungranted one is a 404.
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
import { AnyObject, SpaceSchema, SpacesResponseSchema, projectsApp } from '../lib/app';
import { withProjectGitAuth } from '../lib/git';
import { callerKortixSessionId } from '../lib/caller-session';
import { normalizeString, readBody, type ProjectRow } from '../lib/serializers';
import { loadProjectSessionInventory } from '../lib/session-list';
import { accessibleSpaceSlugs, spaceViewerAccess } from '../lib/space-access';
import { slugify } from '../lib/triggers';
import { loadProjectAgents } from '../agents';
import type { GitBackedProject } from '../git';
import {
  loadProjectSpaces,
  stripSpaceFromTriggers,
  spaceSpecToManifestEntry,
  usableAgentNames,
  type SpaceSessionsMode,
  type SpaceSpec,
} from '../spaces';
import type { ParsedManifest } from '../triggers';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SESSIONS_MODES: readonly SpaceSessionsMode[] = ['private', 'shared'];
/** What a create/update body may carry. `slug` is create-only and immutable —
 *  on a PATCH it lands here as a no-op, not as a rename. */
const SPACE_BODY_KEYS = ['name', 'slug', 'description', 'agent', 'sessions'];

const ParamsWithSlug = z.object({ projectId: z.string(), slug: z.string() });

type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

/** Everything a response needs beyond the spec itself. */
interface SpaceContext {
  sessionCounts: Map<string, number>;
  triggerCounts: Map<string, number>;
  canManage: boolean;
}

function serializeSpace(spec: SpaceSpec, ctx: SpaceContext) {
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
async function loadSpaceView(
  c: Context,
  loaded: Loaded,
  projectId: string,
): Promise<{
  specs: SpaceSpec[];
  errors: Array<{ slug: string; path: string; error: string }>;
  ctx: SpaceContext;
}> {
  const gitProject = await withProjectGitAuth(loaded.row);
  const { loadProjectTriggers } = await import('../triggers');
  const [declared, triggers, canManage] = await Promise.all([
    loadProjectSpaces(gitProject),
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
    await accessibleSpaceSlugs(
      c,
      loaded,
      projectId,
      declared.specs.map((s) => s.slug),
    ),
  );
  const specs = declared.specs.filter((s) => accessible.has(s.slug));

  const triggerCounts = new Map<string, number>();
  for (const spec of triggers.specs) {
    if (!spec.space) continue;
    triggerCounts.set(spec.space, (triggerCounts.get(spec.space) ?? 0) + 1);
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
      loadSpaceAccess: (slugs) => spaceViewerAccess(c, loaded, projectId, slugs),
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
      if (!item.row.space) continue;
      sessionCounts.set(item.row.space, (sessionCounts.get(item.row.space) ?? 0) + 1);
    }
  }

  return { specs, errors: declared.errors, ctx: { sessionCounts, triggerCounts, canManage } };
}

/** Parse the create/update body onto a base spec. Returns the error string the
 *  route should 400 with, or the merged spec. `existing` is null on create. */
function mergeSpaceBody(
  body: Record<string, unknown>,
  existing: SpaceSpec | null,
  slug: string,
  manifestPath: string,
  declaredAgents: readonly string[],
): SpaceSpec | { error: string } {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  // Refuse what this version does not have rather than swallowing it. A client
  // still sending `instructions` or `context` (both dropped 2026-09-07) has to
  // learn that the write does nothing, not lose it silently.
  const unknown = Object.keys(body).find((key) => !SPACE_BODY_KEYS.includes(key));
  if (unknown) {
    return { error: `"${unknown}" is not a space field (allowed: ${SPACE_BODY_KEYS.join(', ')})` };
  }
  const spec: SpaceSpec = existing
    ? { ...existing }
    : {
        slug,
        path: manifestPath,
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
  spec.path = manifestPath;

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
        error: `agent "${agent}" is not usable in this space — declare it in the root manifest's agents:, in spaces.${slug}.agents, or reference it there with { from: <slug> }`,
      };
    }
    spec.agent = agent;
  }
  if (has('sessions')) {
    const sessions = normalizeString(body.sessions);
    if (!sessions || !(SESSIONS_MODES as readonly string[]).includes(sessions)) {
      return { error: 'sessions must be "private" or "shared"' };
    }
    spec.sessions = sessions as SpaceSessionsMode;
  }
  return spec;
}

/** The agent names a space may set as its `agent:` — the globals plus
 *  the ones it owns or references (spec 2026-09-06 §2). On create, globals. */
async function usableAgentsFor(
  gitProject: GitBackedProject,
  existing: SpaceSpec | null,
): Promise<string[]> {
  return usableAgentNames(await loadProjectAgents(gitProject), existing);
}

/** Where the root manifest lives — the file every space is declared in. A
 *  project with no manifest yet uses its configured path, like every other
 *  synthesized-manifest reader. */
async function rootManifestPath(gitProject: GitBackedProject): Promise<string> {
  const { readManifest } = await import('../triggers');
  const manifest = await readManifest(gitProject);
  return manifest?.path ?? gitProject.manifestPath ?? 'kortix.yaml';
}

/**
 * Write one space into the root manifest's `spaces:` map, as ONE commit with
 * the compare-and-swap retry every other manifest edit uses. A lost race is
 * a 409, never a silent overwrite.
 *
 * This replaced a per-space `commitRepoFile` against `kortix-<slug>.yaml`
 * (user, 2026-09-08). The win beyond one fewer file: a space write is now
 * the SAME transaction as a trigger or connector write, so it can never land
 * half-applied against a manifest that moved underneath it.
 */
async function writeSpace(
  row: ProjectRow,
  slug: string,
  spec: SpaceSpec,
  message: string,
  operation: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  return mutateManifestWithRetry(row, operation, (manifest) => {
    const spaces = isTable(manifest.raw.spaces) ? { ...manifest.raw.spaces } : {};
    spaces[slug] = spaceSpecToManifestEntry(spec);
    manifest.raw = { ...manifest.raw, spaces };
    return { ok: true as const, commitMessage: message };
  });
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── GET /v1/projects/:projectId/spaces ────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/spaces',
    tags: ['spaces'],
    summary: 'GET /:projectId/spaces',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: json(SpacesResponseSchema, "The project's accessible spaces"),
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

    const view = await loadSpaceView(c, loaded, projectId);
    return c.json({
      spaces: view.specs.map((spec) => serializeSpace(spec, view.ctx)),
      errors: view.errors,
    });
  },
);

// ─── POST /v1/projects/:projectId/spaces ───────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/spaces',
    tags: ['spaces'],
    summary: 'POST /:projectId/spaces',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      201: json(SpaceSchema, 'The created space'),
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
      loadProjectSpaces(gitProject),
      rootManifestPath(gitProject),
    ]);
    // A block that exists but failed to parse is still that slug's block, so
    // check the raw map too, not just the specs that parsed.
    if (declared.specs.some((s) => s.slug === slug) || declared.errors.some((e) => e.slug === slug)) {
      return c.json(
        {
          error: `A space with slug "${slug}" already exists. Pick a different name.`,
          code: 'SPACE_SLUG_TAKEN',
        },
        409,
      );
    }
    const usable = await usableAgentsFor(gitProject, null);
    const merged = mergeSpaceBody({ ...body, name }, null, slug, rootPath, usable);
    if ('error' in merged) return c.json({ error: merged.error }, 400);
    const committed = await writeSpace(
      loaded.row,
      slug,
      merged,
      `feat(spaces): add ${slug}`,
      `space ${slug} was being created`,
    );
    if (!committed.ok) {
      return c.json({ error: committed.error }, committed.status as 400 | 409 | 502);
    }
    const created: SpaceSpec = merged;
    // A brand-new space has no sessions and no triggers yet, and the
    // author just cleared `project.customize.write`.
    return c.json(
      serializeSpace(created, {
        sessionCounts: new Map(),
        triggerCounts: new Map(),
        canManage: true,
      }),
      201,
    );
  },
);

// ─── GET /v1/projects/:projectId/spaces/:slug ──────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/spaces/{slug}',
    tags: ['spaces'],
    summary: 'GET /:projectId/spaces/:slug',
    ...auth,
    request: { params: ParamsWithSlug },
    responses: {
      200: json(SpaceSchema, 'The space'),
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

    const view = await loadSpaceView(c, loaded, projectId);
    const spec = view.specs.find((s) => s.slug === slug);
    // Undeclared and inaccessible are the SAME answer: a member without the
    // grant must not be able to probe which spaces exist.
    if (!spec) return c.json({ error: 'Not found' }, 404);
    return c.json(serializeSpace(spec, view.ctx));
  },
);

// ─── PATCH /v1/projects/:projectId/spaces/:slug ────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/spaces/{slug}',
    tags: ['spaces'],
    summary: 'PATCH /:projectId/spaces/:slug',
    ...auth,
    request: {
      params: ParamsWithSlug,
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(SpaceSchema, 'The updated space'),
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
      loadProjectSpaces(gitProject),
      rootManifestPath(gitProject),
    ]);
    const current = declared.specs.find((s) => s.slug === slug);
    if (!current) return c.json({ error: 'Not found' }, 404);
    // An empty body is a no-op: no commit, the current shape comes back.
    if (Object.keys(body).length > 0) {
      const usable = await usableAgentsFor(gitProject, current);
      const merged = mergeSpaceBody(body, current, slug, rootPath, usable);
      if ('error' in merged) return c.json({ error: merged.error }, 400);
      const written = await writeSpace(
        loaded.row,
        slug,
        merged,
        `chore(spaces): update ${slug}`,
        `space ${slug} was being updated`,
      );
      if (!written.ok) {
        return c.json({ error: written.error }, written.status as 400 | 409 | 502);
      }
    }
    return c.json(await readOne(c, loaded, projectId, slug));
  },
);

// ─── DELETE /v1/projects/:projectId/spaces/:slug ───────────────────────

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/spaces/{slug}',
    tags: ['spaces'],
    summary: 'DELETE /:projectId/spaces/:slug',
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
    const declared = await loadProjectSpaces(gitProject);
    const current = declared.specs.find((s) => s.slug === slug);
    if (!current) return c.json({ error: 'Not found' }, 404);
    // ONE commit. It used to take two (spec 2026-09-06 §4): detach every
    // trigger naming this space, THEN delete its file — two writes to two
    // files, ordered so neither intermediate state failed validation. With
    // the space and the triggers in the same file, both edits are one
    // atomic commit and the ordering problem is gone (user, 2026-09-08).
    const removed = await mutateManifestWithRetry(
      loaded.row,
      `space ${slug} was being deleted`,
      (manifest: ParsedManifest) => {
        const detached = stripSpaceFromTriggers(manifest, slug);
        const spaces = isTable(detached.raw.spaces) ? { ...detached.raw.spaces } : {};
        delete spaces[slug];
        manifest.raw = { ...detached.raw, spaces };
        return { ok: true as const, commitMessage: `chore(spaces): delete ${slug}` };
      },
    );
    if (!removed.ok) {
      return c.json({ error: removed.error }, removed.status as 400 | 409 | 502);
    }
    return c.json({ ok: true });
  },
);

/** Re-read one space after a write, for the response body. */
async function readOne(c: Context, loaded: Loaded, projectId: string, slug: string) {
  const view = await loadSpaceView(c, loaded, projectId);
  const spec = view.specs.find((s) => s.slug === slug);
  if (!spec) throw new Error(`space ${slug} vanished after a successful write`);
  return serializeSpace(spec, view.ctx);
}
