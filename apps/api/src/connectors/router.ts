/**
 * Connector HTTP surface — one Hono router with two faces:
 *
 *   Gateway (sandbox-facing, KORTIX_TOKEN):
 *     GET  /v1/connectors/catalog             — catalog the session can use
 *     POST /v1/connectors/call                — { connector, action, args } → run
 *
 *   Admin (dashboard-facing, user auth + project access):
 *     GET  /v1/connectors/projects/:projectId/connectors          — list + status
 *     POST /v1/connectors/projects/:projectId/connectors/sync     — re-materialize from kortix.yaml
 *
 * Connectors are project-wide visible — the only access gate is the agent-side
 * `[[agents]].connectors` grant (iam/agent-scope.ts), enforced below.
 *
 * Built against an injected `ConnectorRouterDeps` so the e2e drives the real HTTP
 * layer + real gateway logic with in-memory fakes (db + upstream) at the
 * boundary; production wires DB-backed deps (db-deps.ts).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { makeOpenApiApp } from '../openapi';
import type { ConnectorRouterDeps } from './router-contract';
import { registerConnectorAdminRoutes } from './routes/admin';
import {
  registerConnectCatalogueRoutes,
  registerDiscoverDetailRoutes,
  registerDiscoverRoutes,
} from './routes/catalogues';
import { registerConnectRoutes, registerPipedreamWebhookRoutes } from './routes/connect';
import {
  registerGatewayCallRoutes,
  registerGatewayCatalogRoutes,
  registerProjectAttachmentRoutes,
} from './routes/gateway';
import { registerConnectorSettingsRoutes, registerProjectPolicyRoutes } from './routes/settings';

export { connectorErrorHttpStatus } from './routes/gateway';
export { FEATURE_NOT_SUPPORTED_CODE } from './routes/shared';

export type {
  AdminConnectorView,
  CatalogConnector,
  ConnectorPrincipal,
  ConnectorRouterDeps,
  CrudOutcome,
  DefaultMode,
  ProjectPoliciesViewResponse,
  ProjectPolicyView,
} from './router-contract';

export function createConnectorRouter(deps: ConnectorRouterDeps): OpenAPIHono {
  const app = makeOpenApiApp();

  // Hono dispatches in registration order: keep these calls in this order.
  registerGatewayCatalogRoutes(app, deps);
  registerDiscoverRoutes(app, deps);
  registerProjectAttachmentRoutes(app, deps);
  registerDiscoverDetailRoutes(app, deps);
  registerGatewayCallRoutes(app, deps);
  registerConnectorAdminRoutes(app, deps);
  registerConnectCatalogueRoutes(app, deps);
  registerConnectorSettingsRoutes(app, deps);
  registerConnectRoutes(app, deps);
  registerProjectPolicyRoutes(app, deps);
  registerPipedreamWebhookRoutes(app, deps);

  return app;
}
