import type { ModelRouteInput, ModelRoutePlan, AuthedPrincipal } from '@kortix/llm-gateway';
import { config } from '../../config';
import { catalogModelForWireModel, gatewayModelCatalog } from '../models/catalog-models';
import { platformDefaultModelId, platformVisionModelId, servedManagedModels } from '../models/served-managed-models';
import { effectiveFallbackPolicies } from './policy-config';
import { createGatewayRouteResolver } from './resolve-route';
import { planImageRoute, reachableImageModels } from './image-models';
import { getProjectRoutingPolicy } from '../../repositories/project-routing-policies';
import { getProjectGatewayResolution } from '../../repositories/project-model-access';
import { listProjectSecretNamesForConsumer } from '../../projects/surface';
import { listGrantedGatewaySecretNames } from '../../secrets/account-resource';
import { toWireModel } from '../resolution/effective';
import { resolveDefaultModelForPrincipal } from '../resolution/default-model';

const routingCatalog = () => gatewayModelCatalog('gateway-routing');

/**
 * The image models `principal` reaches, from the names of the credentials it
 * may use, as the model picker counts them (servable-catalog.ts). No secret
 * value is read and no provider is called.
 */
async function principalImageModels(principal: AuthedPrincipal): Promise<string[]> {
  const managedModels = principal.freeModelsOnly ? [] : servedManagedModels().map((model) => model.id);
  const { projectId } = principal;
  if (!projectId) {
    return reachableImageModels({ secretNames: new Set(), access: { disabledProviders: [], disabledModels: [] }, managedModels });
  }
  const personalUserId = principal.personalUserId === undefined ? principal.userId : principal.personalUserId;
  const { access, pooledEnabled } = await getProjectGatewayResolution(projectId);
  const [projectNames, pooledNames] = await Promise.all([
    listProjectSecretNamesForConsumer({ projectId, principalUserId: personalUserId, consumer: 'llm_gateway' }),
    // A gateway API key reaches only keys shared with the whole project (resolve-candidates.ts).
    pooledEnabled
      ? listGrantedGatewaySecretNames(principal.accountId, projectId, principal.userId, principal.keyId ? null : personalUserId)
      : [],
  ]);
  return reachableImageModels({ secretNames: new Set([...projectNames, ...pooledNames]), access, managedModels });
}

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
  imageRoute: (principal, requestedModel) => planImageRoute(requestedModel, () => principalImageModels(principal)),
});

export function resolveGatewayRoute(
  principal: AuthedPrincipal,
  input: ModelRouteInput,
): Promise<ModelRoutePlan> {
  return resolver(principal, input);
}
