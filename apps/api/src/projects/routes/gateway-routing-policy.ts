import { modelAccessAllows, readModelAccess } from '../../llm-gateway/model-access';
import { createRoute, z } from '@hono/zod-openapi';
import {
  GatewayResolutionError,
  type AuthedPrincipal,
} from '@kortix/llm-gateway';
import { type GenerationConfig, clampGenerationConfig } from '@kortix/llm-catalog';
import { resolveCandidates } from '../../llm-gateway/resolution/resolve-candidates';
import { catalogModelForWireModel } from '../../llm-gateway/models/catalog-models';
import { platformDefaultModelId } from '../../llm-gateway/models/served-managed-models';
import { auth, errors, json } from '../../openapi';
import { PROJECT_ACTIONS } from '../../iam/actions';
import {
  assertProjectCapability,
  loadProjectForUser,
  projectCapabilityAllowed,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { config } from '../../config';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { getAccountModelDefaults } from '../../repositories/model-preferences';
import {
  getProjectRoutingPolicy,
  resetProjectRoutingPolicy,
  setProjectRoutingPolicy,
} from '../../repositories/project-routing-policies';
import { invalidateAccountModelDefaults } from '../../llm-gateway/resolution/default-model';
import { parseProjectRoutingPolicyInput } from '../../llm-gateway/routing/project-policy';
import { resolveGatewayRoute } from '../../llm-gateway/routing';

type RoutingContext = { projectId: string; accountId: string; userId: string };

function operatorFallbackFor(model: string) {
  const policy = config.LLM_GATEWAY_FALLBACK_POLICIES.find((candidate) =>
    candidate.models.includes(model),
  );
  return policy
    ? { models: [...policy.fallbackModels], fallbackOn: policy.fallbackOn }
    : { models: [], fallbackOn: 'transient' as const };
}

async function routingPolicyDocument(ctx: RoutingContext, canWrite: boolean) {
  const [stored, defaults] = await Promise.all([
    getProjectRoutingPolicy(ctx.projectId),
    getAccountModelDefaults(ctx.accountId, ctx.projectId),
  ]);
  const projectDefault = defaults.projects[ctx.projectId] ?? null;
  const effectiveDefault = projectDefault ?? defaults.account ?? platformDefaultModelId();
  const defaultModelSource = projectDefault
    ? ('project' as const)
    : defaults.account
      ? ('account' as const)
      : ('platform' as const);
  const route = await resolveGatewayRoute(
    {
      userId: ctx.userId,
      accountId: ctx.accountId,
      projectId: ctx.projectId,
      defaultModel: effectiveDefault,
    },
    { requestedModel: effectiveDefault, requires: { imageInput: false } },
  );
  return {
    version: 1 as const,
    project: {
      defaultModel: projectDefault,
      visionModel: stored?.visionModel ?? null,
      defaultFallback: stored?.defaultFallback ?? null,
      rules: stored?.rules ?? [],
      // Re-clamped on every READ too (not just trusted from what was stored) —
      // the live catalog can change after a value was written (a model
      // losing reasoning_options, temperature support flipping, ...), and
      // the UI must never render a stale, now-invalid control value as if
      // it were still honored. Entries that clamp to nothing are dropped.
      modelGenerationConfig: Object.fromEntries(
        Object.entries(stored?.modelGenerationConfig ?? {})
          .map(
            ([model, entry]) =>
              [model, clampGenerationConfig(entry, catalogModelForWireModel(model))] as const,
          )
          .filter(([, clamped]) => Object.keys(clamped).length > 0),
      ),
    },
    effective: {
      defaultModel: effectiveDefault,
      defaultModelSource,
      visionModel: stored?.visionModel ?? config.LLM_GATEWAY_VISION_MODEL ?? null,
      defaultFallback: {
        models: [...(route.fallbackModels ?? [])],
        fallbackOn: route.fallbackOn ?? 'transient',
      },
    },
    platform: {
      defaultModel: platformDefaultModelId(),
      visionModel: config.LLM_GATEWAY_VISION_MODEL ?? null,
      defaultFallback: operatorFallbackFor(platformDefaultModelId()),
    },
    capabilities: { write: canWrite },
  };
}

const routingPolicyResponses = {
  200: json(z.any(), 'Project gateway routing policy'),
  ...errors(400, 403, 404),
};

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/gateway/routing-policy',
    tags: ['gateway'],
    summary: 'Get the project model routing policy',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: routingPolicyResponses,
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const canWrite = await projectCapabilityAllowed(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MODEL_READ,
    );
    return c.json(
      await routingPolicyDocument(
        {
          projectId,
          accountId: loaded.row.accountId,
          userId: loaded.userId,
        },
        canWrite,
      ),
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/gateway/routing-policy',
    tags: ['gateway'],
    summary: 'Set the project model routing policy',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: z.any() } } },
    },
    responses: routingPolicyResponses,
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
      PROJECT_ACTIONS.PROJECT_MODEL_WRITE,
    );
    let policy;
    try {
      policy = parseProjectRoutingPolicyInput(await c.req.json());
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Invalid routing policy',
          code: 'invalid_routing_policy',
        },
        400,
      );
    }
    const defaults = await getAccountModelDefaults(loaded.row.accountId, projectId);
    const effectivePrimary =
      policy.defaultModel ?? defaults.account ?? platformDefaultModelId();
    if (effectivePrimary && !modelAccessAllows(readModelAccess(loaded.row.metadata), effectivePrimary)) {
      return c.json({ error: 'Enable the default model and its provider before selecting it.', code: 'model_disabled' }, 409);
    }
    if (policy.defaultFallback?.models.includes(effectivePrimary)) {
      return c.json(
        {
          error: `model "${effectivePrimary}" cannot fall back to itself`,
          code: 'invalid_routing_policy',
        },
        400,
      );
    }
    // Clamp every configured entry against the model's LIVE catalog
    // capabilities before it's ever persisted — never store a temperature
    // for a temperature:false model, a reasoning effort outside the model's
    // own reasoning_options, or a max-output-tokens above its limit.output.
    // An entry that clamps to nothing (every field dropped) is dropped
    // entirely rather than stored as an empty object.
    const clampedGenerationConfig = Object.fromEntries(
      Object.entries(policy.modelGenerationConfig)
        .map(
          ([model, entry]) =>
            [model, clampGenerationConfig(entry, catalogModelForWireModel(model))] as const,
        )
        .filter(([, clamped]) => Object.keys(clamped).length > 0),
    );
    await setProjectRoutingPolicy({
      projectId,
      accountId: loaded.row.accountId,
      updatedBy: loaded.userId,
      policy: { ...policy, modelGenerationConfig: clampedGenerationConfig },
    });
    invalidateAccountModelDefaults(loaded.row.accountId);
    return c.json(
      await routingPolicyDocument(
        {
          projectId,
          accountId: loaded.row.accountId,
          userId: loaded.userId,
        },
        true,
      ),
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/gateway/routing-policy',
    tags: ['gateway'],
    summary: 'Remove the project model routing policy',
    ...auth,
    request: { params: z.object({ projectId: z.string() }) },
    responses: routingPolicyResponses,
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
      PROJECT_ACTIONS.PROJECT_MODEL_WRITE,
    );
    await resetProjectRoutingPolicy({ projectId, accountId: loaded.row.accountId });
    invalidateAccountModelDefaults(loaded.row.accountId);
    return c.json(
      await routingPolicyDocument(
        {
          projectId,
          accountId: loaded.row.accountId,
          userId: loaded.userId,
        },
        true,
      ),
    );
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/gateway/routing-policy/preview',
    tags: ['gateway'],
    summary: 'Preview a model routing policy',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              requestedModel: z.string().trim().min(1).max(128),
              imageInput: z.boolean().default(false),
            }),
          },
        },
      },
    },
    responses: routingPolicyResponses,
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json();
    const defaults = await getAccountModelDefaults(loaded.row.accountId, projectId);
    const freeModelsOnly = !(await accountMayUseManagedModels(loaded.row.accountId));
    const principal: AuthedPrincipal = {
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      projectId,
      freeModelsOnly,
      defaultModel: defaults.projects[projectId] ?? defaults.account ?? undefined,
    };
    const route = await resolveGatewayRoute(principal, {
      requestedModel: body.requestedModel,
      requires: { imageInput: body.imageInput === true },
    });
    const models = [route.primaryModel, ...(route.fallbackModels ?? [])];
    // This is an AVAILABILITY PREVIEW, not a generation request: its whole
    // contract is "tell me which of these models are usable right now",
    // per-model. resolveCandidates THROWS a typed GatewayResolutionError
    // (e.g. provider_not_connected) instead of returning [] when a model
    // isn't servable — correct for an actual generation call, but here it
    // must degrade to `available: false` for JUST that model rather than
    // fail the whole Promise.all/response for every model in the list.
    const availability = await Promise.all(
      models.map(async (model) => {
        try {
          return { model, available: (await resolveCandidates(principal, model)).length > 0 };
        } catch (err) {
          if (err instanceof GatewayResolutionError) return { model, available: false };
          throw err;
        }
      }),
    );
    return c.json({ version: 1, route, models: availability });
  },
);
