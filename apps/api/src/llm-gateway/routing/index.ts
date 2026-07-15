import type { ModelRouteInput, ModelRoutePlan, AuthedPrincipal } from '@kortix/llm-gateway';
import { config } from '../../config';
import { gatewayModelCatalog } from '../models/catalog-models';
import { createGatewayRouteResolver } from './resolve-route';
import { getProjectRoutingPolicy } from '../../repositories/project-routing-policies';

const routingCatalog = () => gatewayModelCatalog('gateway-routing');

const resolver = createGatewayRouteResolver({
  defaultModel: config.LLM_GATEWAY_DEFAULT_MODEL,
  visionModel: config.LLM_GATEWAY_VISION_MODEL,
  policies: config.LLM_GATEWAY_FALLBACK_POLICIES,
  supportsImage: (model) => {
    const wire = model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
    return routingCatalog()[wire]?.attachment === true;
  },
  getProjectPolicy: getProjectRoutingPolicy,
});

export function resolveGatewayRoute(
  principal: AuthedPrincipal,
  input: ModelRouteInput,
): Promise<ModelRoutePlan> {
  return resolver(principal, input);
}

export { createGatewayRouteResolver } from './resolve-route';
export type { GatewayRouteResolver, GatewayRouteResolverOptions } from './resolve-route';
