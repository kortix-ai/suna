/**
 * AGI autonomous operations — the shared Hono app for the goals/tasks surface
 * (docs/specs/2026-07-26-agi-autonomous-operations.md).
 *
 * This lives in its own app rather than as another `projects/routes/rN.ts`
 * because the WHOLE surface is experimental (R-44) and ships or dies as a unit:
 * keeping it out of the shipped project router means removing the feature is
 * deleting a directory and one mount line, not unpicking route registrations.
 *
 * It is mounted on the SAME `/v1/projects` prefix as `projectsApp` (a single
 * `app.route()` in src/index.ts), so every path declared here is relative to
 * that prefix — `/{projectId}/agi/tasks` is `/v1/projects/{projectId}/agi/tasks`.
 * There is no path collision: `projectsApp` registers no wildcards under
 * `/{projectId}`, so registration order between the two apps is immaterial.
 *
 * Auth mirrors `projectsApp` exactly — the same bearer tokens address the same
 * projects, so the same middleware must produce the same 401. Routes declare
 * `...auth` only for the OpenAPI security scheme; the runtime 401 comes from
 * here, never from a handler.
 */
import { supabaseAuth } from '../middleware/auth';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';

export const agiApp = makeOpenApiApp<AppEnv>();

agiApp.use('/*', supabaseAuth);
