/**
 * @kortix/sdk — the Kortix frontend data layer, in one package.
 *
 * THIS ROOT ENTRY IS CANONICAL: the whole framework-free surface (client,
 * session, turns, files, message queue, event stream, errors, REST clients)
 * is exported here. Configure once at startup, then use one import. Every
 * host — web, mobile, demo — shares this single implementation; nothing talks
 * to the raw API or OpenCode directly.
 *
 * "Canonical" is asserted, not asserted-in-prose: `root-canonical.test.ts`
 * fails if any name exported by an isomorphic subpath is missing here. The
 * only names allowed to be absent are the browser-only zustand stores, which
 * cannot live at the root because `zustand` is a forbidden import in the
 * isomorphic-core tier (see `index.isomorphic.test.ts`).
 *
 * Only three subpaths exist beyond the root, each for a reason that fits in
 * one sentence:
 *   @kortix/sdk/react       — React is an optional peer dependency
 *   @kortix/sdk/server      — imports node:async_hooks (Node-only)
 *   @kortix/sdk/internal/*  — apps/web's zustand stores; outside semver
 *
 * The 20 legacy subpaths (`/projects-client`, `/turns`, …) still resolve as
 * `@deprecated` aliases under `src/deprecated/` and are removed only on a
 * major.
 *
 * The explicit re-export blocks below double as TS2308 ambiguity pins: a name
 * declared once but reachable through two `export *` paths (ours vs the
 * vendor type star inside core/runtime/client) is pinned to its canonical
 * module here, without renaming anything.
 */
export {
  configureKortix,
  platformConfig,
  isConfigured,
  type KortixPlatformConfig,
  type KortixFeatureFlagOverrides,
} from './core/http/config';

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
} from './core/client/kortix';

/** Workspace file operations (daemon `/file` + `/find`), owned by the SDK. */
export {
  SANDBOX_FS_ROOTS,
  copyFile,
  createFile,
  deleteFile,
  files,
  findFiles,
  findText,
  getCurrentProject,
  getFileStatus,
  getServerHealth,
  isServerReachable,
  isUnderSandboxRoot,
  listFiles,
  mkdir,
  readBlob,
  readFile,
  renameFile,
  toDaemonPath,
  toSandboxAbsolutePath,
  toWorkspaceRelative,
  uploadFile,
  uploadTimeoutMsForBytes,
  writeFile,
} from './core/files/client';
export type * from './core/files/types';

/** Generate a session id (RFC 4122 v4, with a non-secure-context fallback). */
export { generateSessionId } from './platform/session-id';

/**
 * The framework-free outbound message queue — a host's "type while the agent is
 * still working" buffer, as pure reducers over a `SessionQueue` value (no
 * store, no React, no timers). Previously reachable ONLY from
 * `@kortix/sdk/message-queue`, which made the queue a fourth entry point you
 * had to know existed. Re-exported here so the root really is canonical; the
 * subpath keeps working as an alias.
 */
export {
  claimNext,
  completeInFlight,
  createSessionQueue,
  editQueued,
  enqueue,
  failInFlight,
  removeQueued,
  reorderQueued,
  retryFailed,
  type QueuedMessage,
  type QueuedMessageInput,
  type SessionQueue,
} from './core/session/message-queue';

/**
 * Answer the question the agent is blocked on inside its running sandbox —
 * the last resort behind the durable `answerSessionQuestion` for a Monitoring
 * approval when the daemon never relayed the ask.
 */
export { answerSessionRuntimeQuestion, externalIdFromSandboxUrl } from './core/session/runtime-question';

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
export type { SessionHealthResponse, SessionHealthResult } from './core/session/health';

/**
 * A session's resolved runtime (opencode session id + runtime URL + sandbox
 * id) — the shape `ensureReady()` resolves to and the shared session-runtime
 * registry stores. Re-exported so it's nameable from the package's public
 * surface (TS's declaration emit needs this to describe `SessionHandle`'s
 * `ensureReady()` return type without reaching into an internal module path).
 */
export type { SessionRuntimeEntry } from './core/session/session-runtime-registry';

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
} from './core/stream/event-stream';

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
  FEATURE_DISABLED_CODE,
  isFeatureDisabledError,
  featureDisabledKey,
  type ApiErrorFields,
  type BillingErrorUI,
  type FeatureDisabledError,
} from './core/http/api/errors';

/**
 * Exhaustive part/turn classification for building chat UIs — framework-free.
 * `classifyPart` normalizes every opencode `Part` variant (text, reasoning,
 * tool, file, subtask, patch, snapshot, agent, retry, compaction, step) into
 * a `ClassifiedPart`, with a compile-time exhaustiveness check plus a runtime
 * 'unknown' fallback for forward-compat. `classifyTurn` classifies every part
 * of a message and normalizes its `info.error` into a `TurnError`, so a host
 * doesn't have to special-case "assistant message with zero parts but a
 * failure" as silent nothingness. `toolInfo` is a zero-icon tool-name ->
 * {label, category} registry a host maps to its own icon set. Also available
 * from `@kortix/sdk/turns`.
 */
export {
  type ClassifiedAgentPart,
  type ClassifiedCompactionPart,
  type ClassifiedFilePart,
  type ClassifiedPart,
  type ClassifiedPatchPart,
  type ClassifiedReasoningPart,
  type ClassifiedRetryPart,
  type ClassifiedSnapshotPart,
  type ClassifiedStepPart,
  type ClassifiedSubtaskPart,
  type ClassifiedTextPart,
  type ClassifiedToolPart,
  type ClassifiedTurn,
  type ClassifiedUnknownPart,
  type ToolCategory,
  type ToolInfoEntry,
  type ToolStatus,
  type ToolView,
  type TurnError,
  classifyPart,
  classifyTurn,
  humanizeToolName,
  toolInfo,
} from './core/turns';

/**
 * The curated chat-event union — narrows the full `OpenCodeEvent` wire union
 * down to the ~12 events a product chat UI needs (message/part updates,
 * session status/idle/error, question asked/answered, permission
 * asked/replied, todo updated, connection, heartbeat-gap), reshaped into
 * purpose-built payloads. Also available from `@kortix/sdk/event-stream`.
 */
export {
  heartbeatGapEvent,
  narrowChatEvent,
  type KortixChatEvent,
  type KortixChatEventConnection,
  type KortixChatEventHeartbeatGap,
  type KortixChatEventMessageRemoved,
  type KortixChatEventMessageUpdated,
  type KortixChatEventPartRemoved,
  type KortixChatEventPartUpdated,
  type KortixChatEventPermissionAsked,
  type KortixChatEventPermissionReplied,
  type KortixChatEventQuestionAnswered,
  type KortixChatEventQuestionAsked,
  type KortixChatEventSessionError,
  type KortixChatEventSessionIdle,
  type KortixChatEventSessionStatus,
  type KortixChatEventTodoUpdated,
  type KortixChatQuestionInfo,
  type KortixChatQuestionOption,
  type KortixChatToolRef,
} from './core/stream/chat-events';

/**
 * Domain result types from the REST facade (`kortix.project(id).*` /
 * `kortix.session(...)` / `kortix.accounts.*` / `kortix.billing.*`), re-exported
 * type-only so a consumer can name what a facade call returns without a
 * second import from `@kortix/sdk/projects-client`. Additive — no runtime
 * cost, and every name here already lives in `./platform/projects-client`
 * (this is a convenience re-export, not a new surface).
 */
export type {
  // Projects
  KortixProject,
  ProjectConfigSummary,
  ProjectDetail,
  GatewayCatalogModel,
  ProjectLlmCatalogResponse,
  // Accounts / IAM
  KortixAccount,
  AccountDetail,
  AccountBranding,
  AccountBrandingAssetKind,
  AccountBrandingState,
  AccountMember,
  AccountRole,
  ProjectRole,
  ProjectAccessMember,
  ProjectAccessRequest,
  ProjectGroupGrant,
  ProjectResourceGrant,
  PendingProjectInvite,
  PendingApproval,
  // Secrets / connectors
  ProjectSecret,
  ProjectGitConnection,
  ConnectorSharing,
  AdminConnector,
  ConnectorConfig,
  ConnectorDraftInput,
  ConnectorAuthDiscovery,
  ConnectorAuthCandidate,
  ExecutableConnectorAuth,
  DiscoveredAuthScheme,
  // Sessions
  ProjectSession,
  ProjectOpenCodeSession,
  SessionPublicShare,
  SessionAudit,
  SessionTranscript,
  SessionTranscriptMessage,
  SessionTranscriptSource,
  SessionTranscriptSyncEnvelope,
  SessionTranscriptSyncMessage,
  // Change requests / git
  ChangeRequest,
  ChangeRequestDiffResponse,
  ChangeRequestMergePreview,
  ProjectCommit,
  ProjectCommitDetail,
  ProjectCommitFile,
  ProjectBranch,
  // Triggers
  ProjectTrigger,
  ProjectTriggerListing,
  // Sandbox
  SandboxTemplate,
  ProjectSandboxHealth,
  ProjectSnapshotBuild,
  // Gateway (LLM observability / budgets)
  GatewayLogRow,
  GatewayLogDetail,
  GatewayOverview,
  GatewayBudgetRow,
  GatewayKeyRow,
  // Tokens (CLI PATs)
  AccountToken,
  CreatedAccountToken,
  ProjectCliToken,
  CreatedProjectCliToken,
  // Billing
  AccountState,
  BillingTransaction,
  BillingTransactionsPage,
  BillingTransactionsSummary,
  BillingCreditBreakdown,
  BillingTierConfiguration,
  SessionCostOwnerType,
  SessionCostSummary,
  SessionCostModelUsage,
  SessionCostLlmLedgerEntry,
  SessionCostComputeLedgerEntry,
  SessionCostLedgerEntry,
  SessionCostDetail,
  SessionCostReconciliation,
  SessionCostsPage,
  ListSessionCostsOptions,
  GetSessionCostRecordOptions,
  // Account audit
  AuditEvent,
  AuditEventList,
  AuditWebhook,
  // Setup links (secret-entry / connect-request)
  SecretRequestLink,
  ConnectorRequestLink,
  // Manifest validate / git token
  ManifestValidationResult,
  ProjectGitToken,
  // Gateway playground
  GatewayPlaygroundResponse,
  // Billing mutations
  CheckoutSessionResult,
  PortalSessionResult,
  AutoTopupSettings,
  // Public marketplace catalog (top-level `kortix.marketplace.*`)
  MarketplaceCatalogItem,
  MarketplaceItemsResponse,
  MarketplaceEntry,
  MarketplaceSource,
  // Auth validate helper
  AccountIdentity,
  ValidateTokenResult,
  // Sign in with Kortix — OAuth client registry (`kortix.iam.oauthClients`)
  OAuthClient,
  CreatedOAuthClient,
  CreateOAuthClientInput,
  UpdateOAuthClientInput,
  OAuthClientType,
  OAuthScope,
} from './core/rest/projects-client';

/**
 * Headless regular auth — `kortix.auth.*` (sign-up, password / magic-link /
 * social sign-in, refresh, password reset, sign-out through the Kortix API)
 * and `createKortixSession`, the self-refreshing token store for `getToken`.
 */
export {
  // The functions behind `kortix.auth.*` — exported so `Kortix`'s inferred type
  // stays nameable from the root entry (TS2742 in a consumer's declaration
  // emit otherwise, e.g. apps/whitelabel-demo `next build`).
  signUp,
  signInWithPassword,
  sendMagicLink,
  verifyOtp,
  signInWithProvider,
  exchangeCode,
  refreshSession,
  resetPassword,
  updatePassword,
  authUser,
  signOut,
  HeadlessAuthError,
  type HeadlessAuthApi,
  type AuthSession,
  type AuthUser,
  type AuthSessionResult,
  type AuthOtpType,
  type AuthProvider,
  type AuthRequestOptions,
} from './core/rest/platform-client/auth';
export {
  createKortixSession,
  type KortixSession,
  type KortixSessionOptions,
  type KortixSessionStorage,
} from './core/auth/session';

/**
 * Linear-time trailing-slash strip shared with hosts — see
 * `platform/strings.ts` for why this replaces the regex idiom.
 */
export { stripTrailingSlashes } from './platform/strings';

/**
 * Per-tool view models for `ToolView` — a discriminated union with a typed
 * shape for each tool family a product chat UI renders specially (web/image
 * search, shell, file read/write/edit, grep/glob search, task, todowrite,
 * question), plus a `generic` fallback for everything else. Pairs with
 * `ToolView`'s new `outputParsed`/`outputText` fields and its embedded-
 * failure detection (a `state.status: "completed"` tool part whose JSON
 * output body carries `success: false` or a top-level `error` — the shape
 * router/connector tools like `web_search` commonly return on failure — now
 * classifies as `status: 'error'` instead of rendering as a success with raw
 * JSON inside). Also available from `@kortix/sdk/turns`.
 */
export {
  type DiffLine,
  type DiffLineType,
  type QuestionItem,
  type QuestionOption,
  type SearchMatch,
  type TodoItem,
  type ToolViewModel,
  type WebSearchResultItem,
  shellExitCode,
  toolViewModel,
} from './core/turns/view-model';

// ─────────────────────────────────────────────────────────────────────────────
// Canonical root (Axis 2): everything framework-free lives here.
// The explicit blocks above pin TS2308-ambiguous names to their canonical
// module; the stars below carry the rest of the isomorphic core.
// ─────────────────────────────────────────────────────────────────────────────

// Ambiguity pins for names reachable both from our modules and from the
// vendor type star (`export type * from '@opencode-ai/sdk/v2/client'` inside
// core/runtime/client). Each is declared ONCE in this package; naming it here
// picks the canonical module and silences the ambiguity without renaming.
export { type FileContent, type FileNode } from './core/files/types';
export {
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
} from './core/rest/projects-client/agent-config';

export * from './core/client/kortix';
export * from './core/http/abort-error';
export * from './core/http/api-client';
export * from './core/http/auth';
export * from './core/http/config';
export * from './core/http/feature-flags';
export * from './core/http/fresh-sessions';
export * from './core/http/impersonation';
export * from './core/http/instance-routes';
export * from './core/http/opencode-errors';
export * from './core/rest/platform-client';
export * from './core/rest/projects-client';
export * from './core/runtime/client';
export * from './core/runtime/attachment-part';
export * from './core/session';
export {
  createHttpSessionSyncController,
  loadHttpSessionHistory,
  type SessionSyncMessage,
} from './core/session-sync/session-sync-controller';
export * from './core/session/url';
export * from './core/stream/event-stream';
export * from './core/stream/fetch-sse';
export * from './core/turns';
export * from './transcript';

// Runtime-neutral compatibility names for host applications. The original
// OpenCode-named exports remain public for backward compatibility.
export { formatOpenCodeRuntimeError as formatRuntimeError } from './core/http/opencode-errors';
export type {
  ProjectOpenCodeSession as ProjectRuntimeSession,
} from './core/rest/projects-client/sessions';
export type {
  OpencodeAgentConfig as RuntimeAgentConfig,
} from './core/rest/projects-client/agent-config';

/**
 * Kortix Apps — the viewer, in the browser. An App hosted by Kortix is opened
 * by someone Kortix already authenticated, so `getToken: kortixAppViewerToken()`
 * is the whole of its auth. See `core/auth/app-viewer.ts`. (Kept across the
 * runtime-client revert — app-viewer has no runtime-client dependency.)
 */
export {
  fetchKortixAppViewer,
  kortixAppViewerToken,
  clearKortixAppViewerCache,
  type KortixAppViewerSession,
  type KortixAppViewerOptions,
} from './core/auth/app-viewer';
