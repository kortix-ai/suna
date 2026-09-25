/** Project sandbox templates: list, create, update, delete, and build. */
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import {
  DEFAULT_SANDBOX_SLUG,
  deleteSandboxImage,
  kickRoutedPreBuild,
  listSandboxTemplates,
  templateBuildProviders,
} from '../../snapshots/builder';
import {
  createTemplate,
  deleteTemplate,
  getTemplateById,
  updateTemplate,
} from '../../snapshots/templates';
import { createRoute, z } from '@hono/zod-openapi';
import { loadProjectForUser, assertProjectCapability } from '../lib/access';
import { AnyObject, SandboxTemplateSchema, projectsApp } from '../lib/app';
import { loadGitProject } from '../lib/git';
import { serializeTemplate } from '../lib/serializers';
import { templateProviderObservation } from '../lib/template-provider-observation';

// ─── Template CRUD ─────────────────────────────────────────────────────────
// Full CRUD over `kortix.sandbox_templates`. Shared/platform rows are read-
// only. Project-scoped rows can be created/edited/deleted from the dashboard.

// GET /v1/projects/:projectId/sandbox-templates — same as /sandboxes; thinner
// path for the "templates only" UI surface. We re-use the same serializer.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandbox-templates',
    tags: ['sandboxes'],
    summary: 'GET /:projectId/sandbox-templates',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(SandboxTemplateSchema), 'Sandbox templates'),
        ...errors(404, 500),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const project = await loadGitProject(loaded);
  const observation = templateProviderObservation(loaded.row.metadata);
  try {
    const templates = await listSandboxTemplates(project, observation.listOptions);
    return c.json({
      items: templates.map((t) => serializeTemplate(t)),
      default_slug: templates.find((t) => t.isDefault)?.slug ?? templates[0]?.slug ?? null,
      provider_mode: observation.providerMode,
      selected_provider: observation.selectedProvider,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to list templates: ${message}` }, 500);
  }
},
);

// POST /v1/projects/:projectId/sandbox-templates — create a custom template.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sandbox-templates',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/sandbox-templates',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(SandboxTemplateSchema, 'The created sandbox template'),
        ...errors(400, 404, 409, 503),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: rebuilding snapshots/templates re-provisions infra. Gated on
  // project.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Managers hold it by default.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (!slug || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    return c.json({ error: 'slug must be lowercase letters/digits/_- (1-64 chars)' }, 400);
  }
  if (slug === DEFAULT_SANDBOX_SLUG) {
    return c.json({ error: 'slug "default" is reserved for the platform template' }, 409);
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : slug;
  const image = typeof body.image === 'string' && body.image.trim() ? body.image.trim() : undefined;
  const dockerfilePath = typeof body.dockerfile_path === 'string' && body.dockerfile_path.trim()
    ? body.dockerfile_path.trim()
    : undefined;
  if ((image && dockerfilePath) || (!image && !dockerfilePath)) {
    return c.json({ error: 'Provide exactly one of `image` or `dockerfile_path`.' }, 400);
  }
  const entrypoint = typeof body.entrypoint === 'string' && body.entrypoint.trim()
    ? body.entrypoint.trim()
    : undefined;
  const cpu = typeof body.cpu === 'number' ? body.cpu : undefined;
  const memoryGb = typeof body.memory_gb === 'number' ? body.memory_gb : undefined;
  const diskGb = typeof body.disk_gb === 'number' ? body.disk_gb : undefined;
  if (templateBuildProviders().length === 0) {
    return c.json({ error: 'No sandbox template provider is enabled' }, 503);
  }

  try {
    const row = await createTemplate({
      projectId,
      accountId: loaded.row.accountId,
      slug,
      name,
      image,
      dockerfilePath,
      entrypoint,
      cpu,
      memoryGb,
      diskGb,
      source: 'ui',
    });
    // Kick a build in the background so the template is ready for the next session.
    const project = await loadGitProject(loaded);
    kickRoutedPreBuild(project, {
      slug: row.slug,
      accountId: loaded.row.accountId,
      source: 'manual',
    });
    return c.json({ template_id: row.templateId, slug: row.slug }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('duplicate') || message.includes('idx_sandbox_templates_project_slug')) {
      return c.json({ error: `A template with slug "${slug}" already exists.` }, 409);
    }
    return c.json({ error: message }, 400);
  }
},
);

// PATCH /v1/projects/:projectId/sandbox-templates/:templateId — update fields.

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sandbox-templates/{templateId}',
    tags: ['sandboxes'],
    summary: 'PATCH /:projectId/sandbox-templates/:templateId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), templateId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: rebuilding snapshots/templates re-provisions infra. Gated on
  // project.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Managers hold it by default.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) ?? {}; } catch { /* empty */ }

  const patch = {
    name: typeof body.name === 'string' ? body.name.trim() : undefined,
    image: 'image' in body ? (typeof body.image === 'string' ? body.image.trim() || null : null) : undefined,
    dockerfilePath: 'dockerfile_path' in body
      ? (typeof body.dockerfile_path === 'string' ? body.dockerfile_path.trim() || null : null)
      : undefined,
    entrypoint: 'entrypoint' in body
      ? (typeof body.entrypoint === 'string' ? body.entrypoint.trim() || null : null)
      : undefined,
    cpu: 'cpu' in body ? (typeof body.cpu === 'number' ? body.cpu : null) : undefined,
    memoryGb: 'memory_gb' in body ? (typeof body.memory_gb === 'number' ? body.memory_gb : null) : undefined,
    diskGb: 'disk_gb' in body ? (typeof body.disk_gb === 'number' ? body.disk_gb : null) : undefined,
  };

  // Ownership check BEFORE the write. updateTemplate keys the UPDATE on
  // templateId alone, so without this a manager of their own project could
  // mutate any other tenant's template by id (the post-write projectId check
  // below only masks the response — the write had already committed). Mirrors
  // the sibling DELETE handler.
  const existing = await getTemplateById(templateId);
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (existing.projectId !== projectId) return c.json({ error: 'Not found' }, 404);

  try {
    const updated = await updateTemplate(templateId, patch, projectId);
    if (!updated) return c.json({ error: 'Not found' }, 404);
    if (updated.projectId !== projectId) return c.json({ error: 'Not found' }, 404);
    // An edit changes the content-addressed identity just like creation. Audit
    // and (when needed) rebuild that identity independently on every enabled
    // provider so the template cannot remain ready on only the provider that
    // happens to launch the next session. Cache hits make metadata-only edits
    // cheap while still healing any provider that drifted or was never built.
    const project = await loadGitProject(loaded);
    kickRoutedPreBuild(project, {
      slug: updated.slug,
      accountId: loaded.row.accountId,
      source: 'manual',
    });
    return c.json({
      template_id: updated.templateId,
      slug: updated.slug,
      build_status: 'started',
      providers: templateBuildProviders(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
},
);

// DELETE /v1/projects/:projectId/sandbox-templates/:templateId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sandbox-templates/{templateId}',
    tags: ['sandboxes'],
    summary: 'DELETE /:projectId/sandbox-templates/:templateId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), templateId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: rebuilding snapshots/templates re-provisions infra. Gated on
  // project.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Managers hold it by default.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.projectId !== projectId) return c.json({ error: 'Not found' }, 404);
  if (row.isShared) return c.json({ error: 'Shared platform templates cannot be deleted.' }, 409);

  try {
    // Best-effort: clear this content identity from every enabled provider.
    const project = await loadGitProject(loaded);
    await Promise.all(
      templateBuildProviders().map((provider) =>
        deleteSandboxImage(project, { slug: row.slug, provider }).catch(() => null),
      ),
    );
    await deleteTemplate(templateId);
    return c.body(null, 204);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
},
);

// POST /v1/projects/:projectId/sandbox-templates/:templateId/build — trigger
// a build (fire-and-forget). Returns 202.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sandbox-templates/{templateId}/build',
    tags: ['sandboxes'],
    summary: 'POST /:projectId/sandbox-templates/:templateId/build',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), templateId: z.string() }),
      },
    responses: {
        202: json(z.any(), 'OK'),
        ...errors(404, 503),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const templateId = c.req.param('templateId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Capability gate: building a sandbox template provisions infra. Gated on
  // project.customize.write so a custom role can withhold it (humans) AND the
  // agent-grant fold applies (agent sessions). Managers hold it by default.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

  const row = await getTemplateById(templateId);
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.projectId !== null && row.projectId !== projectId) {
    return c.json({ error: 'Not found' }, 404);
  }

  const project = await loadGitProject(loaded);
  const providers = templateBuildProviders();
  if (providers.length === 0) {
    return c.json({ error: 'No sandbox template provider is enabled' }, 503);
  }
  kickRoutedPreBuild(project, {
    slug: row.slug,
    accountId: loaded.row.accountId,
    source: 'manual',
  });
  return c.json({
    status: 'started',
    template_id: row.templateId,
    slug: row.slug,
    providers,
  }, 202);
},
);
