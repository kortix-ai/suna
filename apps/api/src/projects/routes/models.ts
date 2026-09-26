/** Project model catalog, picker, access, enablement, and default-model preferences. */
import { readModelAccess } from '../../llm-gateway/model-access';
import { changeProjectModelAccess } from '../../repositories/project-model-access';
import { createRoute, z } from '@hono/zod-openapi';
import { projects, sessionSandboxes } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { llmPriceMarkup } from '../../billing/services/tiers';
import { config } from '../../config';
import { PROJECT_ACTIONS } from '../../iam';
import { isSessionSandboxCredential } from '../../middleware/session-sandbox-credential';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { gatewayModelCatalog } from '../../llm-gateway/models/catalog-models';
import { managedPricingRoutes } from '../../llm-gateway/models/managed-pricing-routes';
import { servableProjectCatalog } from '../../llm-gateway/models/servable-catalog';
import { runtimeModelCatalog } from '../../llm-gateway/models/runtime-catalog';
import { platformDefaultModelId } from '../../llm-gateway/models/served-managed-models';
import {
  invalidateAccountModelDefaults,
  isModelServableForAccount,
  resolveEffectiveModel,
} from '../../llm-gateway/resolution/default-model';
import { toWireModel } from '../../llm-gateway/resolution/effective';
import { auth, errors } from '../../openapi';
import {
  deleteAccountModelPreference,
  getAccountModelDefaults,
  upsertAccountModelPreference,
} from '../../repositories/model-preferences';
import { setProjectModelOverrides } from '../../repositories/project-routing-policies';
import { db } from '../../shared/db';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { requestPersonalOwner } from '../lib/personal-resources';

// GET /v1/projects/:projectId/llm-catalog
// Server-side source of truth for the gateway model catalog. The seed daemon
// fetches it at PARK with a sandbox token so the no-restart warm-fork bakes the
// full picker into opencode config. The web UI also reads it with normal project
// auth so the model picker is available before the sandbox runtime answers.
// The catalog is non-secret; access is still scoped to this project.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/llm-catalog',
    tags: ['projects'],
    summary: 'GET /:projectId/llm-catalog',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const accountId = c.get('accountId') as string | undefined;
    const sandboxId = c.get('sandboxId') as string | undefined;
    let projectMetadata: unknown;
    let ownerAccountId: string | undefined;
    if (isSessionSandboxCredential(c) && accountId && sandboxId) {
      const [sandbox] = await db
        .select({ sandboxId: sessionSandboxes.sandboxId })
        .from(sessionSandboxes)
        .where(
          and(
            eq(sessionSandboxes.sandboxId, sandboxId),
            eq(sessionSandboxes.projectId, projectId),
            eq(sessionSandboxes.accountId, accountId),
            inArray(sessionSandboxes.status, ['provisioning', 'active']),
          ),
        )
        .limit(1);
      if (!sandbox) {
        return c.json({ error: 'sandbox token is not scoped to this project' }, 403);
      }
      const [project] = await db
        .select({ metadata: projects.metadata })
        .from(projects)
        .where(and(eq(projects.projectId, projectId), eq(projects.accountId, accountId)))
        .limit(1);
      if (!project) return c.json({ error: 'Not found' }, 404);
      projectMetadata = project.metadata;
      ownerAccountId = accountId;
    } else {
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      projectMetadata = loaded.row.metadata;
      ownerAccountId = loaded.row.accountId as string | undefined;
    }
    if (!projectLlmGatewayEnabled(projectMetadata)) {
      return c.json(
        { error: 'LLM gateway is disabled for this project', code: 'llm_gateway_disabled' },
        404,
      );
    }
    // Free-tier accounts see only managed models explicitly marked free plus
    // their own BYOK/Codex-connected catalog entries. Paid managed models and
    // synthetic AUTO stay hidden from the picker.
    const freeManagedOnly = ownerAccountId
      ? !(await accountMayUseManagedModels(ownerAccountId))
      : false;
    const models = gatewayModelCatalog(projectId, { freeManagedOnly });
    return c.json({ models });
  },
);

// GET /v1/projects/:projectId/model-picker
// UI-specific, connection-aware projection of the runtime catalog. The full
// /llm-catalog response remains available for sandbox/OpenCode configuration;
// interactive selectors should use this bounded payload instead.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/model-picker',
    tags: ['projects'],
    summary: 'GET /:projectId/model-picker',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.any() } } },
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!projectLlmGatewayEnabled(loaded.row.metadata)) {
      return c.json(
        { error: 'LLM gateway is disabled for this project', code: 'llm_gateway_disabled' },
        404,
      );
    }

    const accountId = loaded.row.accountId as string;
    // One composition, shared with the sandbox's boot fetch
    // (`/v1/llm/models?scope=picker`) — see servableProjectCatalog.
    const catalog = await servableProjectCatalog({
      projectId,
      accountId,
      // Keys shared with the whole project count for the caller as a member;
      // personal provider keys only for the on-behalf-of human (spec
      // 2026-09-22 §2.3). Same split as the sandbox's own list.
      principalUserId: loaded.userId,
      personalUserId: await requestPersonalOwner(c, loaded),
    });
    const quotes = managedPricingRoutes(
      config.MORPH_MANAGED_MODELS,
      llmPriceMarkup(),
      Boolean(config.MORPH_API_KEY),
    );
    return c.json({
      ...catalog,
      managedPricingRoutes: Object.fromEntries(
        Object.entries(quotes).filter(([id]) => id in catalog.models),
      ),
    });
  },
);

// Explicit inference controls are separate from legacy picker visibility.
const modelAccessChangeBody = z.object({
  target: z.enum(['provider', 'model']),
  id: z.string().trim().min(1).max(256),
  enabled: z.boolean(),
}).strict();

projectsApp.openapi(createRoute({
  method: 'get', path: '/{projectId}/model-access', tags: ['projects'],
  summary: 'Read project provider and model access', ...auth,
  request: { params: z.object({ projectId: z.string() }) },
  responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.any() } } }, ...errors(403, 404) },
}), async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const defaults = await getAccountModelDefaults(loaded.row.accountId, projectId);
  return c.json({
    ...readModelAccess(loaded.row.metadata),
    defaultModel: toWireModel(defaults.projects[projectId] ?? defaults.account ?? platformDefaultModelId() ?? '') || undefined,
    enforced: projectLlmGatewayEnabled(loaded.row.metadata),
  });
});

projectsApp.openapi(createRoute({
  method: 'put', path: '/{projectId}/model-access', tags: ['projects'],
  summary: 'Enable or disable a project provider or model', ...auth,
  request: { params: z.object({ projectId: z.string() }),
    body: { content: { 'application/json': { schema: modelAccessChangeBody } } } },
  responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.any() } } }, ...errors(400, 403, 404, 409) },
}), async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  const parsed = modelAccessChangeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
  const change = parsed.data;
  if (change.target === 'provider' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(change.id)) {
    return c.json({ error: 'Invalid provider id', code: 'invalid_body' }, 400);
  }
  if (change.target === 'model') {
    change.id = toWireModel(change.id);
    if (!change.id || change.id === 'auto' || /\s/.test(change.id)) {
      return c.json({ error: 'Use a concrete model id', code: 'invalid_body' }, 400);
    }
  }
  const defaults = await getAccountModelDefaults(loaded.row.accountId, projectId);
  const defaultModel = toWireModel(defaults.projects[projectId] ?? defaults.account ?? platformDefaultModelId() ?? '') || undefined;
  const result = await changeProjectModelAccess({ projectId, updatedBy: c.get('userId'), defaultModel, change });
  if (result.conflict) return c.json({
    error: 'Change the project default to another enabled provider or model first.',
    code: 'cannot_disable_default', defaultModel,
  }, 409);
  invalidateAccountModelDefaults(loaded.row.accountId);
  return c.json({ ...result.policy, defaultModel, enforced: projectLlmGatewayEnabled(loaded.row.metadata) });
});

// PUT /v1/projects/:projectId/model-enablement  { modelOverrides: {id: boolean} }
// Replace the project's EXCEPTIONS to the default model set (the newest model
// per family). Display-only: it decides what the pickers OFFER, never what the
// gateway serves. An empty object restores the pure default. Refuses to turn
// off the project's own default model (the picker would hide what `auto`
// resolves to).
const modelEnablementBody = z.object({
  modelOverrides: z.record(z.string().min(1).max(128), z.boolean()),
});

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/model-enablement',
    tags: ['projects'],
    summary: 'PUT /:projectId/model-enablement',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: modelEnablementBody } } },
    },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.any() } } },
      ...errors(400, 403, 404, 409),
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
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    const accountId = loaded.row.accountId as string;
    const userId = c.get('userId') as string;

    const parsed = modelEnablementBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    }
    const modelOverrides: Record<string, boolean> = {};
    for (const [model, enabled] of Object.entries(parsed.data.modelOverrides)) {
      const wire = toWireModel(model.trim());
      if (wire) modelOverrides[wire] = enabled;
    }

    // A project must never turn off the model its own `auto` resolves to. Only
    // an explicit `false` can do that — omitting it leaves the default in
    // charge, which always offers the current one.
    const defaults = await getAccountModelDefaults(accountId, projectId);
    const effectiveDefault =
      defaults.projects[projectId] ?? defaults.account ?? platformDefaultModelId();
    if (effectiveDefault && modelOverrides[toWireModel(effectiveDefault)] === false) {
      return c.json(
        {
          error: 'Cannot disable the project default model — change the default first.',
          code: 'cannot_disable_default',
        },
        409,
      );
    }

    await setProjectModelOverrides({ projectId, updatedBy: userId, modelOverrides });
    return c.json({ ok: true, modelOverrides });
  },
);

// GET /v1/projects/:projectId/llm-catalog/providers
// The PROVIDER-level rows the connect modal needs (id, name, auth-relevant
// env vars, docs URL) — /llm-catalog above only ever serialized MODEL-level
// entries (Record<"provider/model", GatewayModel>), so the web connect modal
// (apps/web/src/lib/llm-providers.ts) fell back to piggybacking on
// @kortix/llm-catalog's BAKED catalog.generated.json snapshot as its only
// source, which nothing in CI refreshes (models.dev moves; this doesn't).
// This route serves the SAME live, 24h-refreshed, atomic-last-known-good
// runtimeModelCatalog every other gateway/model endpoint already reads —
// literally the `Catalog` shape @kortix/llm-catalog exports, so the web
// client can feed it through the exact same toEntry()/order() it already
// has, no reshaping.
//
// Deliberately NOT gated by projectLlmGatewayEnabled unlike /llm-catalog and
// /model-picker above: the BYOK provider connect modal (which env vars to
// collect, which providers show "connected") is meaningful for EVERY
// project, including native (non-gateway) ones — that's the majority of
// projects and exactly the surface the connect modal serves. Non-secret
// model metadata; scoped to project auth only for consistency with the
// other catalog routes, not because it needs to be secret.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/llm-catalog/providers',
    tags: ['projects'],
    summary: 'GET /:projectId/llm-catalog/providers',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: { description: 'OK', content: { 'application/json': { schema: z.any() } } },
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    return c.json(runtimeModelCatalog.snapshot());
  },
);

// ─── Default model preferences (account-scoped) ─────────────────────────────
// The gateway is the source of truth for concrete model defaults. These routes
// manage account, project, and agent defaults. Stored values are gateway wire
// models (bare managed id, BYOK `provider/model`, or `codex/…`).

// GET /v1/projects/:projectId/model-defaults
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/model-defaults',
    tags: ['projects'],
    summary: 'GET /:projectId/model-defaults',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!projectLlmGatewayEnabled(loaded.row.metadata)) {
      return c.json(
        { error: 'LLM gateway is disabled for this project', code: 'llm_gateway_disabled' },
        404,
      );
    }
    const ownerAccountId = loaded.row.accountId as string;
    const userId = c.get('userId') as string;
    const defaults = await getAccountModelDefaults(ownerAccountId, projectId);
    const freeTier = !(await accountMayUseManagedModels(ownerAccountId));
    // Honest project-level resolution (project → account → platform) + where it
    // came from, so the UI can show "Sonnet 4.6 · project default". The
    // authoritative per-request resolution still happens in the gateway.
    const resolved = await resolveEffectiveModel({
      userId,
      accountId: ownerAccountId,
      projectId,
      explicit: null,
      freeModelsOnly: freeTier,
    });
    return c.json({
      platformDefault: platformDefaultModelId(),
      accountDefault: defaults.account,
      agentDefaults: defaults.agents,
      projectDefault: defaults.projects[projectId] ?? null,
      resolvedForCaller: resolved.model ?? (freeTier ? null : platformDefaultModelId()),
      resolvedSource: resolved.source,
      freeTier,
    });
  },
);

const ModelDefaultBody = z.object({
  scope: z.enum(['account', 'agent', 'project']),
  agentName: z.string().min(1).max(128).optional(),
  model: z.string().min(1).max(128),
});

// PUT /v1/projects/:projectId/model-defaults
projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/model-defaults',
    tags: ['projects'],
    summary: 'PUT /:projectId/model-defaults',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: ModelDefaultBody } } },
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.customize.write is the real gate.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!projectLlmGatewayEnabled(loaded.row.metadata)) {
      return c.json(
        { error: 'LLM gateway is disabled for this project', code: 'llm_gateway_disabled' },
        404,
      );
    }
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    const ownerAccountId = loaded.row.accountId as string;
    const userId = c.get('userId') as string;

    const parsed = ModelDefaultBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', code: 'invalid_body' }, 400);
    }
    const { scope, agentName, model } = parsed.data;
    if (scope === 'agent' && !agentName) {
      return c.json(
        { error: 'agentName is required for scope=agent', code: 'agent_name_required' },
        400,
      );
    }

    const freeModelsOnly = !(await accountMayUseManagedModels(ownerAccountId));
    const servable = await isModelServableForAccount({
      userId,
      accountId: ownerAccountId,
      projectId,
      freeModelsOnly,
      model,
    });
    if (!servable) {
      return c.json(
        {
          error: `Model "${model}" is not available for this account`,
          code: 'model_not_servable',
        },
        409,
      );
    }

    await upsertAccountModelPreference({
      accountId: ownerAccountId,
      scope,
      // agent → agent name; project → the project id; account → '' (in the repo).
      scopeKey: scope === 'agent' ? agentName : scope === 'project' ? projectId : undefined,
      // agent-scope pins are project-scoped — see repositories/model-preferences.ts.
      projectId: scope === 'agent' ? projectId : undefined,
      model,
      updatedBy: userId,
    });
    invalidateAccountModelDefaults(ownerAccountId);
    return c.json({
      ok: true,
      scope,
      agentName: scope === 'agent' ? agentName : undefined,
      model,
    });
  },
);

// DELETE /v1/projects/:projectId/model-defaults?scope=account|agent&agentName=
projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/model-defaults',
    tags: ['projects'],
    summary: 'DELETE /:projectId/model-defaults',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({
        scope: z.enum(['account', 'agent', 'project']),
        agentName: z.string().min(1).max(128).optional(),
      }),
    },
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.any() } },
      },
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    // Floor 'read'; project.customize.write is the real gate.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    if (!projectLlmGatewayEnabled(loaded.row.metadata)) {
      return c.json(
        { error: 'LLM gateway is disabled for this project', code: 'llm_gateway_disabled' },
        404,
      );
    }
    const ownerAccountId = loaded.row.accountId as string;
    const scope = c.req.query('scope');
    const agentName = c.req.query('agentName');
    if (scope !== 'account' && scope !== 'agent' && scope !== 'project') {
      return c.json(
        { error: "scope must be 'account', 'agent', or 'project'", code: 'invalid_scope' },
        400,
      );
    }
    if (scope === 'agent' && !agentName) {
      return c.json(
        { error: 'agentName is required for scope=agent', code: 'agent_name_required' },
        400,
      );
    }
    const scopeKey = scope === 'agent' ? agentName : scope === 'project' ? projectId : undefined;
    await deleteAccountModelPreference({
      accountId: ownerAccountId,
      scope,
      scopeKey,
      projectId: scope === 'agent' ? projectId : undefined,
    });
    invalidateAccountModelDefaults(ownerAccountId);
    return c.json({ ok: true, scope, agentName: scope === 'agent' ? agentName : undefined });
  },
);
