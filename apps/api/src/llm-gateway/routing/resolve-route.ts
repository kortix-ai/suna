import {
  createModelFallbackPolicyEngine,
  type AuthedPrincipal,
  type ModelFallbackPolicy,
  type ModelGenerationDefaults,
  type ModelRouteInput,
  type ModelRoutePlan,
} from '@kortix/llm-gateway';
import { type CatalogModel, clampGenerationConfig } from '@kortix/llm-catalog';
import type { ProjectModelGenerationConfig, ProjectRoutingFallback, ProjectRoutingRule } from './project-policy';

export interface ResolvedProjectRoutingPolicy {
  visionModel: string | null;
  defaultFallback: ProjectRoutingFallback | null;
  rules: ProjectRoutingRule[];
  modelGenerationConfig?: ProjectModelGenerationConfig;
}

export interface GatewayRouteResolverOptions {
  defaultModel: string;
  visionModel: string;
  policies: readonly ModelFallbackPolicy[];
  supportsImage: (model: string) => boolean;
  getProjectPolicy?: (projectId: string) => Promise<ResolvedProjectRoutingPolicy | null>;
  /**
   * Resolve `model`'s live catalog capability record (reasoning_options,
   * temperature, limit.output, ...) — used ONLY to clamp a project's
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
// the live catalog can change between when a project configured a generation
// default and when a request actually resolves it (a model losing
// reasoning_options, a provider changing its temperature support, ...). This
// is the last, authoritative gate before a value reaches the wire.
function generationDefaultsFor(
  model: string,
  config: ProjectModelGenerationConfig | undefined,
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
    const isAuto = input.requestedModel === 'auto' || input.requestedModel === 'kortix/auto';
    const projectPolicy = principal.projectId && options.getProjectPolicy
      ? await options.getProjectPolicy(principal.projectId)
      : null;
    let primaryModel = isAuto
      ? principal.defaultModel || options.defaultModel
      : input.requestedModel;

    if (isAuto && input.requires.imageInput && !options.supportsImage(primaryModel)) {
      primaryModel = projectPolicy?.visionModel || options.visionModel;
    }

    const generationDefaults = generationDefaultsFor(
      primaryModel,
      projectPolicy?.modelGenerationConfig,
      catalogModelFor,
    );

    const exactRule = projectPolicy?.rules.find((rule) => rule.model === primaryModel);
    if (exactRule) {
      return {
        policyId: `project:exact:${primaryModel}`,
        primaryModel,
        fallbackModels: exactRule.fallbackModels,
        fallbackOn: exactRule.fallbackOn,
        generationDefaults,
      };
    }

    if (isAuto && projectPolicy?.defaultFallback) {
      return {
        policyId: 'project:default',
        primaryModel,
        fallbackModels: projectPolicy.defaultFallback.models,
        fallbackOn: projectPolicy.defaultFallback.fallbackOn,
        generationDefaults,
      };
    }

    const policy = fallbackPolicies.route(primaryModel);
    if (!policy) {
      return {
        policyId: isAuto ? 'auto' : 'direct',
        primaryModel,
        fallbackModels: [],
        fallbackOn: 'transient',
        generationDefaults,
      };
    }

    return {
      policyId: policy.policyId,
      primaryModel,
      fallbackModels: policy.fallbackModels,
      fallbackOn: policy.fallbackOn,
      generationDefaults,
    };
  };
}
