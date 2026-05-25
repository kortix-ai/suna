/**
 * Executor subsystem entry — the production HTTP router, wired to DB-backed deps.
 * Mounted at /v1/executor in the app. Gateway routes (/connectors, /call) use
 * KORTIX_EXECUTOR_TOKEN auth (resolved inside db-deps); admin routes
 * (/projects/:id/connectors*) sit behind combinedAuth (applied at the mount).
 */
import { createExecutorRouter } from './router';
import { dbExecutorRouterDeps } from './db-deps';

export const executorApp = createExecutorRouter(dbExecutorRouterDeps);
