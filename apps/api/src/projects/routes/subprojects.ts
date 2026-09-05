/**
 * Subproject CRUD — `kortix.yaml` → `subprojects.<slug>`.
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
import { commitRepoFile, slugify } from '../lib/triggers';
import { loadProjectAgents } from '../agents';
import {
  extractSubprojects,
  isRepoRelativeContextPath,
  removeSubprojectFromManifest,
  stripSubprojectFromTriggers,
  upsertSubprojectInManifest,
  type SubprojectSessionsMode,
  type SubprojectSpec,
} from '../subprojects';
import type { ParsedManifest } from '../triggers';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SESSIONS_MODES: readonly SubprojectSessionsMode[] = ['private', 'shared'];
/** UTF-8 ceiling for an uploaded context file. Big enough for a brief or a
 *  brand guide, small enough that a commit stays a commit. */
const CONTEXT_FILE_MAX_BYTES = 256 * 1024;

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
    instructions: spec.instructions,
    context: spec.context,
    agent: spec.agent,
    sessions: spec.sessions,
    path: spec.path,
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
  const { loadProjectSubprojects } = await import('../subprojects');
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
  const spec: SubprojectSpec = existing
    ? { ...existing, context: [...existing.context] }
    : {
        slug,
        path: `${manifestPath}#subprojects.${slug}`,
        name: slug,
        description: null,
        instructions: null,
        context: [],
        agent: null,
        sessions: 'private',
      };
  spec.slug = slug;
  spec.path = `${manifestPath}#subprojects.${slug}`;

  if (has('name')) {
    const name = normalizeString(body.name);
    if (!name) return { error: 'name must be a non-empty string' };
    spec.name = name;
  }
  // `null` clears an optional field; omitting it leaves it alone.
  if (has('description')) spec.description = normalizeString(body.description);
  if (has('instructions')) {
    spec.instructions =
      typeof body.instructions === 'string' && body.instructions.trim()
        ? body.instructions
        : null;
  }
  if (has('agent')) {
    const agent = normalizeString(body.agent);
    if (agent && !declaredAgents.includes(agent)) {
      return {
        error: `agent "${agent}" does not match any declared agent in this project`,
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
  if (has('context')) {
    if (body.context === null) spec.context = [];
    else if (!Array.isArray(body.context)) {
      return { error: 'context must be a list of repo-relative paths' };
    } else {
      const bad = body.context.find((item) => !isRepoRelativeContextPath(item));
      if (bad !== undefined) {
        return {
          error:
            'each context entry must be a non-empty repo-relative path (no leading "/" and no "..")',
        };
      }
      spec.context = [...new Set(body.context.map((item) => (item as string).trim()))];
    }
  }
  return spec;
}

/** The agent names a project declares — the `agent:` field must name one. */
async function declaredAgentNames(project: ProjectRow): Promise<string[]> {
  const loaded = await loadProjectAgents(await withProjectGitAuth(project));
  return loaded.specs.map((spec) => spec.name);
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

    const agents = await declaredAgentNames(loaded.row);
    let created: SubprojectSpec | undefined;
    const result = await mutateManifestWithRetry(
      loaded.row,
      `subproject ${slug} was being created`,
      (manifest: ParsedManifest) => {
        if (extractSubprojects(manifest).specs.some((s) => s.slug === slug)) {
          return {
            ok: false as const,
            error: `A subproject with slug "${slug}" already exists. Pick a different name.`,
            status: 409,
            code: 'SUBPROJECT_SLUG_TAKEN',
          };
        }
        const merged = mergeSubprojectBody({ ...body, name }, null, slug, manifest.path, agents);
        if ('error' in merged) return { ok: false as const, error: merged.error, status: 400 };
        const next = upsertSubprojectInManifest(manifest, merged);
        manifest.raw = next.raw;
        created = merged;
        return { ok: true as const, commitMessage: `feat(subprojects): add ${slug}` };
      },
    );
    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}) },
        result.status as 400 | 409 | 502,
      );
    }
    if (!created) throw new Error('subproject create completed without a spec');
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

    const agents = await declaredAgentNames(loaded.row);
    const result = await mutateManifestWithRetry(
      loaded.row,
      `subproject ${slug} was being updated`,
      (manifest: ParsedManifest) => {
        const current = extractSubprojects(manifest).specs.find((s) => s.slug === slug);
        if (!current) return { ok: false as const, error: 'Not found', status: 404 };
        // An empty patch is a no-op: answer 200 without touching git.
        if (Object.keys(body).length === 0) return { ok: true as const, commitMessage: null };
        const merged = mergeSubprojectBody(body, current, slug, manifest.path, agents);
        if ('error' in merged) return { ok: false as const, error: merged.error, status: 400 };
        const next = upsertSubprojectInManifest(manifest, merged);
        manifest.raw = next.raw;
        return { ok: true as const, commitMessage: `chore(subprojects): update ${slug}` };
      },
    );
    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}) },
        result.status as 400 | 404 | 409 | 502,
      );
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

    const result = await mutateManifestWithRetry(
      loaded.row,
      `subproject ${slug} was being deleted`,
      (manifest: ParsedManifest) => {
        if (!extractSubprojects(manifest).specs.some((s) => s.slug === slug)) {
          return { ok: false as const, error: 'Not found', status: 404 };
        }
        // ONE commit: dropping the block while a trigger still names it would
        // leave the manifest failing `validateTriggerSubprojectRefsV2`.
        const next = stripSubprojectFromTriggers(
          removeSubprojectFromManifest(manifest, slug),
          slug,
        );
        manifest.raw = next.raw;
        return { ok: true as const, commitMessage: `chore(subprojects): delete ${slug}` };
      },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 502);
    }
    // Session rows keep `project_sessions.subproject` — a manager still sees
    // them, a member without a grant loses them. Grant rows are left orphaned
    // and are flagged as such by GET /resource-grants.
    return c.json({ ok: true });
  },
);

// ─── POST /v1/projects/:projectId/subprojects/:slug/context ─────────────────

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/subprojects/{slug}/context',
    tags: ['subprojects'],
    summary: 'POST /:projectId/subprojects/:slug/context',
    ...auth,
    request: {
      params: ParamsWithSlug,
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(SubprojectSchema, 'The subproject with the new context entry'),
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

    const rawPath = normalizeString(body.path);
    if (!rawPath) return c.json({ error: 'path is required' }, 400);
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) return c.json({ error: 'content is required' }, 400);
    const byteSize = new TextEncoder().encode(content).byteLength;
    if (byteSize > CONTEXT_FILE_MAX_BYTES) {
      return c.json(
        { error: `content exceeds ${CONTEXT_FILE_MAX_BYTES} bytes (got ${byteSize})` },
        400,
      );
    }
    // Only the BASENAME is used, so a caller cannot escape the subproject's own
    // directory with `../` or an absolute path.
    const basename = rawPath.split(/[\\/]/).pop() ?? '';
    if (!basename || basename === '.' || basename === '..') {
      return c.json({ error: `path "${rawPath}" has no usable file name` }, 400);
    }
    const repoPath = `.kortix/subprojects/${slug}/${basename}`;

    // Refuse before writing a file for a subproject that does not exist.
    const gitProject = await withProjectGitAuth(loaded.row);
    const { loadProjectSubprojects } = await import('../subprojects');
    const declared = await loadProjectSubprojects(gitProject);
    if (!declared.specs.some((s) => s.slug === slug)) {
      return c.json({ error: 'Not found' }, 404);
    }

    const committed = await commitRepoFile(
      loaded.row,
      repoPath,
      content,
      `feat(subprojects): add ${basename} to ${slug}`,
    );
    if ('error' in committed) {
      return c.json({ error: committed.error }, committed.status as 400 | 409 | 502);
    }

    const result = await mutateManifestWithRetry(
      loaded.row,
      `subproject ${slug} context was being added`,
      (manifest: ParsedManifest) => {
        const current = extractSubprojects(manifest).specs.find((s) => s.slug === slug);
        if (!current) return { ok: false as const, error: 'Not found', status: 404 };
        if (current.context.includes(repoPath)) {
          // The file was re-uploaded; it is committed, and the entry is already
          // listed. Nothing to change in the manifest.
          return { ok: true as const, commitMessage: null };
        }
        const next = upsertSubprojectInManifest(manifest, {
          ...current,
          context: [...current.context, repoPath],
        });
        manifest.raw = next.raw;
        return { ok: true as const, commitMessage: `feat(subprojects): context for ${slug}` };
      },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 502);
    }
    return c.json(await readOne(c, loaded, projectId, slug));
  },
);

// ─── DELETE /v1/projects/:projectId/subprojects/:slug/context?path= ─────────

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/subprojects/{slug}/context',
    tags: ['subprojects'],
    summary: 'DELETE /:projectId/subprojects/:slug/context',
    ...auth,
    request: {
      params: ParamsWithSlug,
      query: z.object({ path: z.string() }),
    },
    responses: {
      200: json(SubprojectSchema, 'The subproject without that context entry'),
      ...errors(400, 403, 404, 409, 502),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const slug = c.req.param('slug');
    const path = normalizeString(c.req.query('path'));
    if (!path) return c.json({ error: 'path is required' }, 400);
    const loaded = await loadProjectForUser(c, projectId, 'manage');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );

    const result = await mutateManifestWithRetry(
      loaded.row,
      `subproject ${slug} context was being removed`,
      (manifest: ParsedManifest) => {
        const current = extractSubprojects(manifest).specs.find((s) => s.slug === slug);
        if (!current) return { ok: false as const, error: 'Not found', status: 404 };
        if (!current.context.includes(path)) {
          return { ok: false as const, error: `"${path}" is not a context entry`, status: 404 };
        }
        const next = upsertSubprojectInManifest(manifest, {
          ...current,
          context: current.context.filter((entry) => entry !== path),
        });
        manifest.raw = next.raw;
        // The repo FILE is deliberately left in place — a context entry is a
        // reference, and other subprojects or agents may read the same path.
        return { ok: true as const, commitMessage: `chore(subprojects): context for ${slug}` };
      },
    );
    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 502);
    }
    return c.json(await readOne(c, loaded, projectId, slug));
  },
);

/** Re-read one subproject after a write, for the response body. */
async function readOne(c: Context, loaded: Loaded, projectId: string, slug: string) {
  const view = await loadSubprojectView(c, loaded, projectId);
  const spec = view.specs.find((s) => s.slug === slug);
  if (!spec) throw new Error(`subproject ${slug} vanished after a successful write`);
  return serializeSubproject(spec, view.ctx);
}
