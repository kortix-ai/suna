/**
 * `@kortix/sdk/sandbox` — the sandbox daemon control surface.
 *
 * Verified against the current Sandbox Agent Server
 * (`apps/kortix-sandbox-agent-server`, rewritten 2026-05): proxy / preview /
 * web-proxy URL building (`/proxy/:port`, `/web-proxy`, path + subdomain forms),
 * the `/kortix/health` liveness probe, and the preview-proxy auth helpers.
 *
 * Dead legacy endpoints are deliberately excluded: `/kortix/ports` (gone — port
 * data comes from the platform API), root `/env` CRUD (the daemon only has
 * `POST /kortix/env`; project secrets are the backend `/v1/projects/:id/secrets`),
 * `/kortix/services/*`, and the `/kortix/{projects,tickets,milestones}` board.
 */

export * from './url';
export * from './health';
export * from './preview';

import * as url from './url';
import * as health from './health';
import * as preview from './preview';

/** Grouped namespace for discoverability: `sandbox.url.*`, `sandbox.health.*`, `sandbox.preview.*`. */
export const sandbox = { url, health, preview };
