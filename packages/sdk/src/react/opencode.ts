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

export * from './use-opencode-sessions';
export * from './use-opencode-events';
export * from './use-opencode-local';
export * from './use-opencode-mcp';
export * from './use-opencode-pty';
export * from './use-opencode-config';
export * from './use-model-store';
export * from './use-model-hydration';
export * from './use-session-sync';
// The client health poller (useSandboxConnection) was REMOVED — readiness is now
// server-truth via `useSession` (/start `stage==='ready'`, seeded into the
// connection store), so there is no poll loop to halt (the old first-load
// 503-halt bug is structurally impossible). The connection STORE is still
// exported below for hosts that drive readiness themselves.
// The live pending-request store. The SSE event stream writes agent QUESTIONS
// and PERMISSION requests here (keyed by request id, each carrying sessionID);
// `useSessionSync` does NOT surface them, so a host that renders interactive
// prompts must read them from this store.
export { useOpenCodePendingStore } from '../state/opencode-pending-store';
export {
  useSandboxConnectionStore,
  type SandboxConnectionStatus,
} from '../state/sandbox-connection-store';
export * from './use-session-prefetch';
export * from './use-canonical-opencode-session';
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
export type { ProjectConfigSummary } from '../platform/projects-client';

// ── The one-hook session surface ─────────────────────────────────────────────
// `useSession(projectId, sessionId)` collapses the entire runtime dance (start →
// switch → health → SSE → id-resolution → message sync) into a single hook so a
// host never touches the sandbox. The primitives below are what it composes —
// also exported standalone for hosts that want the pieces (a model picker, a boot
// pill, the new-session hand-off) without a full session.
export { useSession, type SessionPhase, type UseSessionResult, type UseSessionOptions } from './use-session';
export { useSessionPicks, type SessionPicks } from './use-session-picks';
export { useRuntimePhase, type RuntimePhase } from './use-runtime-phase';
export {
  startStashKey,
  writeStartStash,
  readStartStash,
  clearStartStash,
  type StartStash,
} from './session-start-stash';
