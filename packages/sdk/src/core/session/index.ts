/**
 * `@kortix/sdk/session` — a session's runtime surface.
 *
 * The host thinks in sessions, never in sandboxes: a session owns its runtime,
 * so health + preview/proxy URLs hang off the session. Most hosts reach these
 * through the `createKortix(...).session(pid, sid)` handle (`.health()`,
 * `.previewUrl()`, `.proxyUrl()`); these named exports exist for stateless use
 * (e.g. detecting/parsing localhost URLs in agent output during rendering).
 *
 * Verified against the current agent server (rewritten 2026-05): proxy/preview/
 * web-proxy URL building (`/proxy/:port`, `/web-proxy`, path + subdomain forms),
 * the `/kortix/health` liveness probe, and the preview-proxy auth helpers. Dead
 * legacy endpoints (`/kortix/ports`, `/env` CRUD, `/kortix/services`, the board)
 * are excluded.
 */

export * from './url';
export * from './health';
export * from './preview';
