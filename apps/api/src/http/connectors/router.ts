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
 * `[[agents]].connectors` grant (services/iam/agent-scope.ts), enforced below.
 *
 * Built against an injected `ConnectorRouterDeps` so the e2e drives the real HTTP
 * layer + real gateway logic with in-memory fakes (db + upstream) at the
 * boundary; production wires DB-backed deps (db-deps.ts).
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { makeOpenApiApp } from '../openapi';
import type { ConnectorRouterDeps } from '../../services/connectors/router-contract';
import { registerConnectorAdminRoutes } from './admin';
import {
  registerConnectCatalogueRoutes,
  registerDiscoverDetailRoutes,
  registerDiscoverRoutes,
} from './catalogues';
import { registerConnectRoutes, registerPipedreamWebhookRoutes } from './connect';
import {
  registerGatewayCallRoutes,
  registerGatewayCatalogRoutes,
  registerProjectAttachmentRoutes,
} from './gateway';
import { registerConnectorSettingsRoutes, registerProjectPolicyRoutes } from './settings';

export { connectorErrorHttpStatus } from './gateway';
export { FEATURE_NOT_SUPPORTED_CODE } from './shared';

export type {
  AdminConnectorView,
  CatalogAccount,
  CatalogConnector,
  ConnectorPrincipal,
  ConnectorRouterDeps,
  CrudOutcome,
  DefaultMode,
  ListCatalogOptions,
  ProjectPoliciesViewResponse,
  ProjectPolicyView,
  SyncResult,
} from '../../services/connectors/router-contract';

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
