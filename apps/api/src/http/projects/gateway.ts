// Registers every gateway route on `projectsApp`. The routes live in focused
// sibling modules; the calls below run in registration order.
import { registerGatewayLogsRoutes } from './gateway-logs';
import { registerGatewaySpendRoutes } from './gateway-spend';
import { registerGatewayKeysRoutes } from './gateway-keys';
import { registerGatewayPlaygroundRoutes } from './gateway-playground';
import { registerGatewayProvidersRoutes } from './gateway-providers';
import { registerGatewayRoutingPolicyRoutes } from './gateway-routing-policy';

export function registerGatewayRoutes(): void {
  registerGatewayLogsRoutes();
  registerGatewaySpendRoutes();
  registerGatewayKeysRoutes();
  registerGatewayPlaygroundRoutes();
  registerGatewayProvidersRoutes();
  registerGatewayRoutingPolicyRoutes();
}
