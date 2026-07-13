import {
  createModelFallbackPolicyEngine,
  type AuthedPrincipal,
  type ModelFallbackPolicy,
  type ModelRouteInput,
  type ModelRoutePlan,
} from '@kortix/llm-gateway';

export interface GatewayRouteResolverOptions {
  defaultModel: string;
  visionModel: string;
  policies: readonly ModelFallbackPolicy[];
  supportsImage: (model: string) => boolean;
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
    let primaryModel = isAuto
      ? principal.defaultModel || options.defaultModel
      : input.requestedModel;

    if (isAuto && input.requires.imageInput && !options.supportsImage(primaryModel)) {
      primaryModel = options.visionModel;
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
