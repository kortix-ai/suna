import type { ModelRouteInput, ModelRoutePlan, AuthedPrincipal } from '@kortix/llm-gateway';
import { config } from '../../config';
import { catalogModelForWireModel, gatewayModelCatalog } from '../models/catalog-models';
import { platformDefaultModelId } from '../models/served-managed-models';
import { createGatewayRouteResolver } from './resolve-route';
import { getWorkspaceRoutingPolicy } from '../../repositories/workspace-routing-policies';

const routingCatalog = () => gatewayModelCatalog('gateway-routing');

const resolver = createGatewayRouteResolver({
  // The RESOLVABLE platform default, not the raw configured one — `auto` must
  // never resolve to a managed model whose transport credential is absent.
  defaultModel: platformDefaultModelId(),
  visionModel: config.LLM_GATEWAY_VISION_MODEL,
  policies: config.LLM_GATEWAY_FALLBACK_POLICIES,
  supportsImage: (model) => {
    const wire = model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
    return routingCatalog()[wire]?.attachment === true;
  },
  getWorkspacePolicy: getWorkspaceRoutingPolicy,
  catalogModelFor: (model) => catalogModelForWireModel(model),
});

export function resolveGatewayRoute(
  principal: AuthedPrincipal,
  input: ModelRouteInput,
): Promise<ModelRoutePlan> {
  return resolver(principal, input);
}

export { createGatewayRouteResolver } from './resolve-route';
export type { GatewayRouteResolver, GatewayRouteResolverOptions } from './resolve-route';
