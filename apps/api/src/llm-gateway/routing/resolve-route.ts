import {
  createModelFallbackPolicyEngine,
  type AuthedPrincipal,
  type ModelFallbackPolicy,
  type ModelGenerationDefaults,
  type ModelRouteInput,
  type ModelRoutePlan,
} from '@kortix/llm-gateway';
import { type CatalogModel, clampGenerationConfig } from '@kortix/llm-catalog';
import type { WorkspaceModelGenerationConfig, WorkspaceRoutingFallback, WorkspaceRoutingRule } from './workspace-policy';

export interface ResolvedWorkspaceRoutingPolicy {
  visionModel: string | null;
  defaultFallback: WorkspaceRoutingFallback | null;
  rules: WorkspaceRoutingRule[];
  modelGenerationConfig?: WorkspaceModelGenerationConfig;
}

export interface GatewayRouteResolverOptions {
  defaultModel: string;
  /** Reroute target for image-bearing default requests; empty/undefined = no reroute. */
  visionModel: string | undefined;
  policies: readonly ModelFallbackPolicy[];
  supportsImage: (model: string) => boolean;
  getWorkspacePolicy?: (workspaceId: string) => Promise<ResolvedWorkspaceRoutingPolicy | null>;
  /**
   * Resolve `model`'s live catalog capability record (reasoning_options,
   * temperature, limit.output, ...) — used ONLY to clamp a workspace's
   * configured generation defaults before they're injected into a request
   * (see `generationDefaultsFor` below). Defaults to
   * `catalogModelForWireModel` (apps/api's models/catalog-models.ts);
   * overridable so tests don't need a live runtime catalog.
   */
  catalogModelFor?: (model: string) => CatalogModel | undefined;
}

export type GatewayRouteResolver = (
  principal: AuthedPrincipal,
  input: ModelRouteInput,
) => Promise<ModelRoutePlan>;

// Re-clamped here (NOT just trusted from what was clamped at write time) —
// the live catalog can change between when a workspace configured a generation
// default and when a request actually resolves it (a model losing
// reasoning_options, a provider changing its temperature support, ...). This
// is the last, authoritative gate before a value reaches the wire.
function generationDefaultsFor(
  model: string,
  config: WorkspaceModelGenerationConfig | undefined,
  catalogModelFor: (model: string) => CatalogModel | undefined,
): ModelGenerationDefaults | undefined {
  const entry = config?.[model];
  if (!entry) return undefined;
  const clamped = clampGenerationConfig(entry, catalogModelFor(model));
  return Object.keys(clamped).length ? clamped : undefined;
}

/**
 * Build the API/control-plane route resolver. The policy engine is generic;
 * this host-owned layer supplies the actual model ids and account defaults.
 */
export function createGatewayRouteResolver(
  options: GatewayRouteResolverOptions,
): GatewayRouteResolver {
  const fallbackPolicies = createModelFallbackPolicyEngine(options.policies);
  const catalogModelFor = options.catalogModelFor ?? (() => undefined);

  return async (principal, input) => {
    const workspacePolicy = principal.workspaceId && options.getWorkspacePolicy
      ? await options.getWorkspacePolicy(principal.workspaceId)
      : null;
    const concreteDefault = principal.defaultModel || options.defaultModel;
    const isDefaultRequest = input.requestedModel === concreteDefault;
    let primaryModel = input.requestedModel;

    if (isDefaultRequest && input.requires.imageInput && !options.supportsImage(primaryModel)) {
      // No configured vision target (the managed lineup has no vision model
      // since the 2026-08-10 slim-down) → keep the default model rather than
      // rerouting to a dead ref that resolves as model_not_found.
      const visionTarget = workspacePolicy?.visionModel || options.visionModel;
      if (visionTarget) primaryModel = visionTarget;
    }

    // Bound once per request (not per candidate) — cheap (a config lookup +
    // a catalog map lookup), and gives every candidate in the failover loop
    // its OWN freshly-clamped defaults instead of trusting the primary
    // model's. See `ModelRoutePlan.generationDefaultsForModel`'s doc comment.
    const generationDefaultsForModel = (model: string): ModelGenerationDefaults | undefined =>
      generationDefaultsFor(model, workspacePolicy?.modelGenerationConfig, catalogModelFor);
    const generationDefaults = generationDefaultsForModel(primaryModel);

    const exactRule = workspacePolicy?.rules.find((rule) => rule.model === primaryModel);
    if (exactRule) {
      return {
        policyId: `project:exact:${primaryModel}`,
        primaryModel,
        fallbackModels: exactRule.fallbackModels,
        fallbackOn: exactRule.fallbackOn,
        generationDefaults,
        generationDefaultsForModel,
      };
    }

    if (isDefaultRequest && workspacePolicy?.defaultFallback) {
      return {
        policyId: 'project:default',
        primaryModel,
        fallbackModels: workspacePolicy.defaultFallback.models,
        fallbackOn: workspacePolicy.defaultFallback.fallbackOn,
        generationDefaults,
        generationDefaultsForModel,
      };
    }

    const policy = fallbackPolicies.route(primaryModel);
    if (!policy) {
      return {
        policyId: 'direct',
        primaryModel,
        fallbackModels: [],
        fallbackOn: 'transient',
        generationDefaults,
        generationDefaultsForModel,
      };
    }

    return {
      policyId: policy.policyId,
      primaryModel,
      fallbackModels: policy.fallbackModels,
      fallbackOn: policy.fallbackOn,
      generationDefaults,
      generationDefaultsForModel,
    };
  };
}
