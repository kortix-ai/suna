'use client';

/**
 * @kortix/sdk/react — OpenCode React hook surface.
 *
 * Barrel re-exporting EVERY hook, query-key factory, provider, and type from
 * the ported `use-opencode-*` / `use-*` hook modules. The web UI imports these
 * by exact name + return shape, so this file is the public contract — keep it
 * exhaustive and in parity with the source hooks.
 *
 * The 4 cross-module duplicates (`McpStatus`, `useOpenCodeMcpStatus`,
 * `ModelKey`, `useVisibleAgents`) are same-symbol re-exports (the secondary
 * module re-exports the primary's binding), so the overlapping `export *`
 * statements resolve to a single declaration with no ambiguity.
 */

// ─────────────────────────────────────────────────────────────────────────────
// FINAL PUBLIC SURFACE (Phase 7). A new host should reach a session through ONE
// hook — `useSession(projectId, sessionId)` — plus the pre-runtime capability
// hooks (`useProjectModels` / `useVisibleAgents` / `useProjectConfig`) and the
// primitives (`useSessionPicks` / `useRuntimePhase` / start-stash). The golden
// reference (apps/whitelabel-demo) imports ONLY that surface — no `server-store`,
// no `OpenCodeEventStreamProvider`, no `useCanonicalOpenCodeSession`, no raw
// stores, no `getClient`.
//
// The lower-level exports below (`OpenCodeEventStreamProvider`,
// `useCanonicalOpenCodeSession`, the sandbox-connection / sync / pending stores,
// the per-sandbox session hooks) are now INTERNAL plumbing that `useSession`
// composes. They remain exported ONLY because apps/web still consumes them
// directly through its not-yet-migrated file/terminal/git hooks; once that
// migration lands they come out of the public surface. New hosts: do not import
// them — use `useSession`.
// ─────────────────────────────────────────────────────────────────────────────
// Router-agnostic route scope: the host injects "the project the user is
// looking at" here (Next hosts derive it from useParams once, near the root);
// `useOpenCodeProviders`/`useOpenCodeLocal` resolve it via this context.
export { KortixProjectProvider, useKortixRouteProjectId } from './route-project';
export * from './use-opencode-sessions';
export * from './use-opencode-events';
export * from './use-opencode-local';
export * from './use-model-defaults';
export * from './use-model-enablement';
export * from './use-session-model-selection';
export * from './use-opencode-mcp';
export * from './use-opencode-pty';
export * from './use-opencode-config';
export * from './use-model-store';
export * from './use-session-sync';
export { useOpenCodeAgents as useRuntimeAgents } from './use-opencode-sessions/agents';
export { useOpenCodeCommands as useRuntimeCommands } from './use-opencode-sessions/commands';
export {
  useOpenCodeCurrentProject as useRuntimeCurrentProject,
  useOpenCodePathInfo as useRuntimePathInfo,
} from './use-opencode-sessions/projects';
export { useOpenCodeProviders as useRuntimeProviders } from './use-opencode-sessions/providers';
export {
  mintSessionWireMessageId,
  promptOpenCodeMessage as promptRuntimeMessage,
  useOpenCodeMessages as useRuntimeMessages,
} from './use-opencode-sessions/messages';
export {
  useOpenCodeSession as useRuntimeSession,
  useOpenCodeSessionDiff as useRuntimeSessionDiff,
  useOpenCodeSessionTodo as useRuntimeSessionTodo,
  useOpenCodeSessions as useRuntimeSessions,
} from './use-opencode-sessions/sessions';
export { useOpenCodeRuntimeReady as useRuntimeReady } from './use-opencode-sessions/keys';
export { useOpenCodeEventStream as useRuntimeEventStream } from './use-opencode-events';
export { useOpenCodeLocal as useRuntimeLocal } from './use-opencode-local';
export { useOpenCodePtyList as useRuntimePtyList } from './use-opencode-pty';
export { useOpenCodeConfig as useRuntimeConfig } from './use-opencode-config';
export { useUpdateOpenCodeConfig as useUpdateRuntimeConfig } from './use-opencode-config';
export {
  clearOpencodeEnsureGuard as clearRuntimeEnsureGuard,
  useCanonicalOpenCodeSession as useCanonicalRuntimeSession,
} from './use-canonical-opencode-session';
export { opencodeKeys as runtimeKeys } from './use-opencode-sessions/keys';
export { useExecuteOpenCodeCommand as useExecuteRuntimeCommand } from './use-opencode-sessions/commands';
export { useAbortOpenCodeSession as useAbortRuntimeSession } from './use-opencode-sessions/messages';
export {
  useCreateOpenCodeSession as useCreateRuntimeSession,
  useSummarizeOpenCodeSession as useSummarizeRuntimeSession,
} from './use-opencode-sessions/sessions';
// Runtime health has three independent layers, each covering a failure mode
// the others can't see — do not collapse them:
//   1. Boot readiness is server-truth: `useSession`'s /start resolves
//      `stage==='ready'` only once the backend reached the daemon and OpenCode
//      answered, and seeds that straight into the connection store. No client
//      poll is needed (or trustworthy) to *establish* the first connection.
//   2. In-stream stalls are covered by the SSE heartbeat in
//      `state/event-stream.ts` (`openEventStream`) — a 15s watchdog that
//      forces a reconnect if no event arrives, so a stream that goes quiet
//      recovers on its own.
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
// The live pending-request store. The SSE event stream writes agent QUESTIONS
// and PERMISSION requests here (keyed by request id, each carrying sessionID);
// `useSessionSync` does NOT surface them, so a host that renders interactive
// prompts must read them from this store.
export { useOpenCodePendingStore } from '../browser/stores/opencode-pending-store';
export { useOpenCodePendingStore as useRuntimePendingStore } from '../browser/stores/opencode-pending-store';
export {
  useSandboxConnectionStore,
  type SandboxConnectionStatus,
} from '../browser/stores/sandbox-connection-store';
export {
  requestRuntimeReconnect,
  useSandboxConnectionStore as useRuntimeConnectionStore,
} from '../browser/stores/sandbox-connection-store';
export { useServerStore as useRuntimeStore } from '../browser/stores/server-store';
export { useSyncStore as useSessionStateStore } from '../browser/stores/sync-store';
export * from './use-session-prefetch';
// Relocated from `platform/projects-client/session-sandbox` — it types against
// react-query's QueryClient, which the framework-free REST layer must not.
export { prefetchSessionStart } from './prefetch-session-start';
export * from './use-canonical-opencode-session';
export * from './use-gateway-catalog-sync';
export * from './use-visible-agents';
export * from './provider-refresh';
// Runtime-free model catalog → selectable model list. Lets a host build a model
// picker BEFORE a session runtime exists (e.g. on a "new session" screen) by
// feeding `project(id).llmCatalog()` through these, with correct provider/model
// ids — no guessing the gateway-vs-BYOK key format.
export { flattenModels, isOfferedModel, type FlatModel } from './model-flatten';
export {
  GATEWAY_PROVIDER_IDS,
  LLM_PROVIDER_CREDENTIALS,
  connectedGatewayProviderIdsFromSecretNames,
  filterToGatewayProviders,
  applyEnablementToProviderList,
  filterToNativeProviders,
  mergeProjectSecretConnectedProviders,
  mergeProviderLists,
  normalizeProviderList,
  projectLlmCatalogToProviderList,
  providerListHasGateway,
  providerListHasModels,
} from './provider-selection';
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
export {
  useSessionPrompts,
  sessionPromptsPollMs,
  startSessionWithPrompt,
  isOptimisticSessionPrompt,
  optimisticSessionPrompt,
  applyOptimisticPrompt,
  settleOptimisticPrompt,
  removeOptimisticPrompt,
  reconcileOptimisticPrompts,
  OPTIMISTIC_PROMPT_PREFIX,
  SESSION_PROMPTS_POLL_MS,
  SESSION_PROMPTS_IDLE_POLL_MS,
  type StartSessionWithPromptAdapters,
  type UseSessionPromptsResult,
} from './use-session-prompts';
export { useSessionWorkingStore } from '../browser/stores/session-working-store';
export {
  useSessionWorking,
  workingPollMs,
  buildWorkingInputs,
  WORKING_POLL_ACTIVE_MS,
  WORKING_POLL_IDLE_MS,
  type SessionTurnObservation,
  type UseSessionWorkingOptions,
} from './use-session-working';
export { useRuntimePhase, type RuntimePhase } from './use-runtime-phase';
export { useRuntimeBootStalled, RUNTIME_BOOT_STALL_MS } from './use-runtime-boot-stalled';
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
