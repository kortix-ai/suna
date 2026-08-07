/**
 * Connector subsystem entry — the production HTTP router, wired to DB-backed deps.
 * Mounted at /v1/connectors in the app. Gateway routes (/catalog, /call) use
 * KORTIX_CLI_TOKEN auth (resolved inside db-deps); admin routes
 * (/projects/:id/connectors*) sit behind combinedAuth (applied at the mount).
 */
import { createConnectorRouter } from './router';
import { dbConnectorRouterDeps } from './db-deps';

export const connectorApp = createConnectorRouter(dbConnectorRouterDeps);
