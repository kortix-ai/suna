import type { ModelRouteInput, ModelRoutePlan, AuthedPrincipal } from '@kortix/llm-gateway';
import { config } from '../../config';
import { catalogModelForWireModel, gatewayModelCatalog } from '../models/catalog-models';
import { platformDefaultModelId, platformVisionModelId, servedManagedModels } from '../models/served-managed-models';
import { effectiveFallbackPolicies } from './policy-config';
import { createGatewayRouteResolver } from './resolve-route';
import { getProjectRoutingPolicy } from '../../repositories/project-routing-policies';
import { toWireModel } from '../resolution/effective';
import { resolveDefaultModelForPrincipal } from '../resolution/default-model';

const routingCatalog = () => gatewayModelCatalog('gateway-routing');

const resolver = createGatewayRouteResolver({
  // The RESOLVABLE platform default, not the raw configured one — `auto` must
  // never resolve to a managed model whose transport credential is absent.
  defaultModel: platformDefaultModelId,
  visionModel: platformVisionModelId,
  policies: () => effectiveFallbackPolicies(config.LLM_GATEWAY_FALLBACK_POLICIES, servedManagedModels().map((model) => model.id)),
  supportsImage: (model) => {
    const wire = model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
    return routingCatalog()[wire]?.attachment === true;
  },
  getProjectPolicy: getProjectRoutingPolicy,
  resolveDefaultModel: resolveDefaultModelForPrincipal,
  catalogModelFor: (model) => catalogModelForWireModel(model),
  canonicalModel: toWireModel,
});

export function resolveGatewayRoute(
  principal: AuthedPrincipal,
  input: ModelRouteInput,
): Promise<ModelRoutePlan> {
  return resolver(principal, input);
}
