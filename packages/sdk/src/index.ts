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
 *   @kortix/sdk/event-stream     — framework-free SSE connect/reconnect/coalesce primitive
 */
export {
  configureKortix,
  platformConfig,
  isConfigured,
  type KortixPlatformConfig,
  type KortixFeatureFlagOverrides,
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
 * Session transcript formatting — pure `SessionInfo`/`MessageWithParts` →
 * Markdown, zero DOM deps, so any host (web, mobile, CLI) exports a transcript
 * the same way.
 */
export {
  DEFAULT_TRANSCRIPT_OPTIONS,
  formatTranscript,
  getTranscriptFilename,
  type MessageWithParts,
  type SessionInfo,
  type TranscriptOptions,
} from './transcript';

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

/**
 * The framework-free SSE event-stream primitive — connect/reconnect/backoff,
 * heartbeat watchdog, and event coalescing, with ZERO react/react-query
 * imports. `@kortix/sdk/react`'s `useOpenCodeEventStream` is a thin wrapper
 * around this for the React host; any other host (worker, CLI, non-React UI)
 * can call it directly.
 */
export {
  openEventStream,
  type EventStreamClient,
  type EventStreamHandle,
  type EventStreamTimers,
  type OpenCodeEvent,
  type OpenEventStreamOptions,
} from './state/event-stream';

/**
 * Typed error classes for the REST surface — isomorphic (no DOM/React deps),
 * so a server-side "Kortix as a Backend" wrapper can `catch` a call into
 * `backendApi`/`createKortix(...)`, `instanceof BillingError` a 402 and pass
 * the cost/upgrade payload straight through to its own client, or
 * `instanceof ApiError` to branch on `.status`/`.code`. Same classes the
 * React host uses (`@kortix/sdk/react` re-exports from this same module) —
 * one error hierarchy across every host.
 */
export {
  ApiError,
  AuthError,
  BillingError,
  RequestTooLargeError,
  parseBillingError,
  isBillingError,
  formatBillingErrorForUI,
  type ApiErrorFields,
  type BillingErrorUI,
} from './platform/api/errors';
