// The gateway routes live in focused sibling modules. registerGatewayRoutes()
// registers each of them on `projectsApp`, in this order.
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
