/**
 * Connector subsystem entry — the production HTTP router, wired to DB-backed deps.
 * Mounted at /v1/connectors in the app. Gateway routes (/catalog, /call) use
 * KORTIX_TOKEN auth (resolved in principal.ts); admin routes
 * (/projects/:id/connectors*) sit behind combinedAuth (applied at the mount).
 */
import { createConnectorRouter } from './router';
import { dbConnectorRouterDeps } from '../../services/connectors/db-deps';
import { dbConnectorRouterAuth } from './principal';

export const connectorApp = createConnectorRouter({ ...dbConnectorRouterDeps, ...dbConnectorRouterAuth });
