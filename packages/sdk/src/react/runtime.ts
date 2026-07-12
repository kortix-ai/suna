'use client';

/**
 * @kortix/sdk/react — Runtime React hook surface.
 *
 * Barrel re-exporting EVERY hook, query-key factory, provider, and type from
 * the ported `use-runtime-*` / `use-*` hook modules. The web UI imports these
 * by exact name + return shape, so this file is the public contract — keep it
 * exhaustive and in parity with the source hooks.
 *
 * The 4 cross-module duplicates (`McpStatus`, `useRuntimeMcpStatus`,
 * `ModelKey`, `useVisibleAgents`) are same-symbol re-exports (the secondary
 * module re-exports the primary's binding), so the overlapping `export *`
 * statements resolve to a single declaration with no ambiguity.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC SURFACE. A host should reach a project session through ONE hook —
// `useSession(projectId, sessionId)` — plus the pre-runtime capability hooks
// (`useProjectModels` / `useVisibleAgents` / `useProjectConfig`) and primitives
// (`useSessionPicks` / `useRuntimePhase` / start-stash). Session conversation
// transport is ACP-owned; the legacy runtime message sync/event-stream hooks
// are intentionally not exported.
// ─────────────────────────────────────────────────────────────────────────────
// Router-agnostic route scope: the host injects "the project the user is
// looking at" here (Next hosts derive it from useParams once, near the root);
// `useRuntimeProviders`/`useRuntimeLocal` resolve it via this context.
export { KortixProjectProvider, useKortixRouteProjectId } from './route-project';
export * from './use-runtime-sessions';
export * from './use-runtime-local';
export * from './use-runtime-mcp';
export * from './use-runtime-pty';
export * from './use-runtime-config';
export * from './use-model-store';
// Runtime health has three independent layers, each covering a failure mode
// the others can't see — do not collapse them:
//   1. Boot readiness is server-truth: `useSession`'s /start resolves
//      `stage==='ready'` only once the backend reached the daemon and Runtime
//      answered, and seeds that straight into the connection store. No client
//      poll is needed (or trustworthy) to *establish* the first connection.
//   2. In-stream stalls are covered by ACP stream handling in `useSession`.
//   3. Neither of those promptly detects the runtime dying *mid-session* or a
//      network partition: a dead sandbox's SSE connection can hang rather than
//      error, and the heartbeat only fires once its own timeout elapses. That
//      gap is what `useRuntimeReconnect` (`./use-runtime-reconnect`) closes —
//      an independent liveness probe (`getSessionHealth`/`isRuntimeReady`)
//      polled on its own cadence and written into the same connection store,
//      so the reconnect/offline UI reacts even when the SSE stream itself
//      never surfaces an error. The tradeoff: while healthy it only polls
//      every 30s (`POLL_CONNECTED`), so a mid-session death can take up to
//      ~30s to surface — traded against not hammering a healthy sandbox with a
//      tight poll forever.
export * from './use-runtime-reconnect';
// Legacy runtime pending-request store. ACP-native prompts are surfaced through
// `useSession().acp.envelopes`; this remains exported only for runtime adapter
// screens that have not yet been rewritten.
export { useRuntimePendingStore } from '../browser/stores/runtime-pending-store';
export {
  useSandboxConnectionStore,
  type SandboxConnectionStatus,
} from '../browser/stores/sandbox-connection-store';
// Relocated from `platform/projects-client/session-sandbox` — it types against
// react-query's QueryClient, which the framework-free REST layer must not.
export { prefetchSessionStart } from './prefetch-session-start';
export * from './use-canonical-runtime-session';
export * from './use-gateway-catalog-sync';
export * from './use-visible-agents';
export * from './provider-refresh';
// Runtime-free model catalog → selectable model list. Lets a host build a model
// picker BEFORE a session runtime exists (e.g. on a "new session" screen) by
// feeding `project(id).llmCatalog()` through these, with correct provider/model
// ids — no guessing the gateway-vs-BYOK key format.
export { flattenModels, type FlatModel } from './model-flatten';
export { projectLlmCatalogToProviderList } from './provider-selection';
export { useProjectModels } from './use-project-models';
export { useProjectConfig } from './use-project-config';
export type { ProjectConfigSummary } from '../core/rest/projects-client';

// ── The one-hook session surface ─────────────────────────────────────────────
// `useSession(projectId, sessionId)` collapses the entire runtime dance (start →
// switch → health → SSE → id-resolution → message sync) into a single hook so a
// host never touches the sandbox. The primitives below are what it composes —
// also exported standalone for hosts that want the pieces (a model picker, a boot
// pill, the new-session hand-off) without a full session.
export {
  useSession,
  type SessionPhase,
  type UseSessionResult,
  type UseSessionOptions,
} from './use-session';
export { useSessionPicks, type SessionPicks } from './use-session-picks';
export { useRuntimePhase, type RuntimePhase } from './use-runtime-phase';
export {
  useQuestionSelfHeal,
  hasRunningQuestionTool,
  type UseQuestionSelfHealOptions,
} from './use-question-self-heal';
export {
  usePermissionSelfHeal,
  findPermissionBlockedCandidate,
  hasActiveNonQuestionTool,
  type UsePermissionSelfHealOptions,
} from './use-permission-self-heal';
export {
  startStashKey,
  writeStartStash,
  readStartStash,
  clearStartStash,
  migrateStash,
  migrateLegacyStash,
  type StartStash,
} from './session-start-stash';
