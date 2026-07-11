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

/** Canonical Agent Client Protocol transport and transcript projections. */
export {
  AcpClient,
  AcpRpcError,
  createAcpClient,
  acpTranscriptHtml,
  acpTranscriptJsonl,
  acpTranscriptMarkdown,
  type AcpClientOptions,
  type AcpContentBlock,
  type AcpEnvelope,
  type AcpJsonRpcId,
  type AcpNotification,
  type AcpRequest,
  type AcpResponse,
  type AcpStreamEvent,
  type AcpStreamHandle,
} from './acp';

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
} from './turns/index';

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
} from './state/chat-events';

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
  ProjectLlmCatalogResponse,
  // Accounts / IAM
  KortixAccount,
  AccountDetail,
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
  // Sessions
  ProjectSession,
  ProjectOpenCodeSession,
  SessionPublicShare,
  SessionAudit,
  SessionTranscript,
  SessionTranscriptMessage,
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
  // Marketplace / registry
  MarketplaceInstalledItem,
  MarketplaceInstallResult,
  MarketplaceUpdateStatusEntry,
  MarketplaceUpdatesResponse,
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
} from './platform/projects-client';

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
 * router/executor tools like `web_search` commonly return on failure — now
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
  toolViewModel,
} from './turns/view-model';
