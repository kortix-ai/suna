import {
  createModelFallbackPolicyEngine,
  type AuthedPrincipal,
  type ModelFallbackPolicy,
  type ModelRouteInput,
  type ModelRoutePlan,
} from '@kortix/llm-gateway';
import type { ProjectRoutingFallback, ProjectRoutingRule } from './project-policy';

export interface ResolvedProjectRoutingPolicy {
  visionModel: string | null;
  defaultFallback: ProjectRoutingFallback | null;
  rules: ProjectRoutingRule[];
}

export interface GatewayRouteResolverOptions {
  defaultModel: string;
  visionModel: string;
  policies: readonly ModelFallbackPolicy[];
  supportsImage: (model: string) => boolean;
  getProjectPolicy?: (projectId: string) => Promise<ResolvedProjectRoutingPolicy | null>;
}

export type GatewayRouteResolver = (
  principal: AuthedPrincipal,
  input: ModelRouteInput,
) => Promise<ModelRoutePlan>;

/**
 * Build the API/control-plane route resolver. The policy engine is generic;
 * this host-owned layer supplies the actual model ids and account defaults.
 */
export function createGatewayRouteResolver(
  options: GatewayRouteResolverOptions,
): GatewayRouteResolver {
  const fallbackPolicies = createModelFallbackPolicyEngine(options.policies);

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

    const exactRule = projectPolicy?.rules.find((rule) => rule.model === primaryModel);
    if (exactRule) {
      return {
        policyId: `project:exact:${primaryModel}`,
        primaryModel,
        fallbackModels: exactRule.fallbackModels,
        fallbackOn: exactRule.fallbackOn,
      };
    }

    if (isAuto && projectPolicy?.defaultFallback) {
      return {
        policyId: 'project:default',
        primaryModel,
        fallbackModels: projectPolicy.defaultFallback.models,
        fallbackOn: projectPolicy.defaultFallback.fallbackOn,
      };
    }

    const policy = fallbackPolicies.route(primaryModel);
    if (!policy) {
      return {
        policyId: isAuto ? 'auto' : 'direct',
        primaryModel,
        fallbackModels: [],
        fallbackOn: 'transient',
      };
    }

    return {
      policyId: policy.policyId,
      primaryModel,
      fallbackModels: policy.fallbackModels,
      fallbackOn: policy.fallbackOn,
    };
  };
}
