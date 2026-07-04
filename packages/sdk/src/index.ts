/**
 * @kortix/sdk — the Kortix frontend data layer, in one package.
 *
 * Configure once at startup, then use the React hooks (`@kortix/sdk/react`) or
 * the data modules (subpath imports below). Every host — web, mobile, demo —
 * shares this single implementation; nothing talks to the raw API or OpenCode.
 *
 * The data modules are exposed as subpaths (not merged here) to keep the
 * surface collision-free and tree-shakeable:
 *   @kortix/sdk/react            — all useOpenCode* hooks + providers
 *   @kortix/sdk/opencode-client  — the scoped OpenCode v2 client factory
 *   @kortix/sdk/auth             — authenticatedFetch + token accessors
 *   @kortix/sdk/api-client       — backendApi (typed REST)
 *   @kortix/sdk/projects-client  — project/session REST surface
 *   @kortix/sdk/server-store     — active sandbox/server state
 *   @kortix/sdk/sync-store       — live message/part/status store
 */
export {
  configureKortix,
  platformConfig,
  isConfigured,
  type KortixPlatformConfig,
} from './platform/config';

/**
 * The opinionated single entry point. `createKortix({ getToken })` wires the
 * platform seam and returns one client whose methods cover the whole REST +
 * opencode surface — so a host app imports ONLY from `@kortix/sdk`.
 */
export {
  createKortix,
  SessionNotReadyError,
  type Kortix,
  type ProjectHandle,
  type SessionHandle,
  type SessionModel,
} from './kortix';

/** Workspace file operations (daemon `/file` + `/find`), owned by the SDK. */
export { files } from './files/client';
export type * from './files/types';

/** Generate a session id (RFC 4122 v4, with a non-secure-context fallback). */
export { generateSessionId } from './platform/session-id';

/**
 * A session's runtime surface — proxy/preview/web-proxy URL building + the
 * `/kortix/health` liveness probe. The host reaches these through the session
 * handle (`createKortix(...).session(pid, sid).health()/.previewUrl()/.proxyUrl()`);
 * stateless helpers live at `@kortix/sdk/session`. "Sandbox" never appears in the
 * public surface — a session owns its runtime.
 */
export type { SessionHealthResponse, SessionHealthResult } from './session/health';

/**
 * A session's resolved runtime (opencode session id + runtime URL + sandbox
 * id) — the shape `ensureReady()` resolves to and the shared session-runtime
 * registry stores. Re-exported so it's nameable from the package's public
 * surface (TS's declaration emit needs this to describe `SessionHandle`'s
 * `ensureReady()` return type without reaching into an internal module path).
 */
export type { SessionRuntimeEntry } from './state/session-runtime-registry';
