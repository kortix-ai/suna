/**
 * @kortix/sdk — the Kortix frontend data layer, in one package.
 *
 * THIS ROOT ENTRY IS CANONICAL: the whole framework-free surface (client,
 * session, turns, files, message queue, event stream, errors, REST clients)
 * is exported here. Configure once at startup, then use one import. Every
 * host — web, mobile, demo — shares this single implementation; nothing talks
 * to the raw API or the session runtime directly.
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
 * session runtime surface — so a host app imports ONLY from `@kortix/sdk`.
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
  FileExistsError,
  fileDownloadRequest,
  findFiles,
  findText,
  getCurrentWorkspace, getCurrentProject,
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
  uploadNativeFile,
  uploadTimeoutMsForBytes,
  writeFile,
} from './core/files/client';
export type { NativeFilePart, UploadFileOptions, UploadProgressEvent } from './core/files/client';
export type * from './core/files/types';

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
 * the stateless helpers are exported here too. "Sandbox" never appears in the
 * public surface — a session owns its runtime.
 */
export type { RuntimeCapability, SessionHealthResponse, SessionHealthResult } from './core/session/health';
export { hasSessionDesktop, runtimeSupports } from './core/session/health';
export {
  CREDIT_ACCOUNT_PAYMENT_STATUSES,
  RUNTIME_CAPABILITIES,
  SESSION_CONTROL_FRAME_TYPES,
  SESSION_PROMPT_REASONS,
  SESSION_START_RESUMING_REASONS,
  SESSION_START_TRANSPORT_REASONS,
  SESSION_STREAM_FRAME_TYPES,
  THREAD_STATUSES,
  isParkedRuntimeDownReason,
  isSessionPromptReason,
  isSessionStartTransportReason,
  isThreadWorking,
  toKortixSessionStatusType,
  toRuntimeThreadStatus,
} from './core/wire-values';
export type {
  CreditAccountPaymentStatus,
  KortixSessionStatusType,
  SessionControlFrameType,
  SessionPromptAdmissionReason,
  SessionPromptReason,
  SessionStartResumingReason,
  SessionStartTransportReason,
  SessionStreamFrameType,
  ThreadActivity,
  ThreadStatus,
} from './core/wire-values';

/**
 * A session's resolved runtime (runtime session id + runtime URL + sandbox
 * id) — the shape `ensureReady()` resolves to and the shared session-runtime
 * registry stores. Re-exported so it's nameable from the package's public
 * surface (TS's declaration emit needs this to describe `SessionHandle`'s
 * `ensureReady()` return type without reaching into an internal module path).
 */
export type { SessionRuntimeEntry } from './core/session/session-runtime-registry';

/**
 * The Kortix message-id clock. `mintWireMessageId` mints the `messageId`
 * for `session.prompts.create()`: the id is the prompt's position in the
 * transcript, and a hand-rolled encoding sorts wrong. The rest decode, order,
 * and place ids on the wrapping 48-bit clock. Also at `@kortix/sdk/wire-message-id`,
 * which loads this one module alone.
 */
export {
  WIRE_ID_BACKDATE_MS,
  WIRE_ID_CLOCK_TOLERANCE,
  WIRE_ID_TIME_MASK,
  WIRE_ID_TIME_SCALE,
  WIRE_MESSAGE_ID,
  isWireIdAheadOf,
  maxWireIdClock,
  mintWireMessageId,
  mintWireMessageIdAbove,
  newestWireIdClock,
  wireIdClock,
  wireIdClockAt,
  wireIdClockDelta,
} from './core/session/wire-message-id';
export type {
  MintWireMessageIdAboveInput,
  MintWireMessageIdOptions,
  MintedWireMessageId,
} from './core/session/wire-message-id';

/**
 * The framework-free SSE event-stream primitive — connect/reconnect/backoff,
 * heartbeat watchdog, and event coalescing, with ZERO react/react-query
 * imports. `@kortix/sdk/react`'s `useRuntimeEventStream` is a thin wrapper
 * around this for the React host; any other host (worker, CLI, non-React UI)
 * can call it directly.
 */
export {
  openEventStream,
  type EventStreamClient,
  type EventStreamConnectionState,
  type EventStreamHandle,
  type EventStreamTimers,
  type RuntimeEvent,
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
  isAuthFailure,
  isBillingError,
  formatBillingErrorForUI,
  FEATURE_DISABLED_CODE,
  isFeatureDisabledError,
  featureDisabledKey,
  REPOSITORY_DISCONNECTED_CODE,
  isRepositoryDisconnectedError,
  NO_WORKSPACE_CODE,
  isNoWorkspaceError,
  repositoryDisconnectedReason,
  type RepositoryDisconnectedReason,
  type ApiErrorFields,
  type BillingErrorUI,
  type FeatureDisabledError,
} from './core/http/api/errors';

/**
 * Exhaustive part/turn classification for building chat UIs — framework-free.
 * `classifyPart` normalizes every transcript `Part` variant (text, reasoning,
 * tool, file, subtask, patch, snapshot, agent, retry, compaction, step) into
 * a `ClassifiedPart`, with a compile-time exhaustiveness check plus a runtime
 * 'unknown' fallback for forward-compat. `classifyTurn` classifies every part
 * of a message and normalizes its `info.error` into a `TurnError`, so a host
 * doesn't have to special-case "assistant message with zero parts but a
 * failure" as silent nothingness. `toolInfo` is a zero-icon tool-name ->
 * {label, category} registry a host maps to its own icon set.
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
 * The curated chat-event union — narrows the full `RuntimeEvent` wire union
 * down to the ~12 events a product chat UI needs (message/part updates,
 * session status/idle/error, question asked/answered, permission
 * asked/replied, todo updated, connection, heartbeat-gap), reshaped into
 * purpose-built payloads.
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
  type KortixChatEventPermissionParked,
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
 * second import. Additive — no runtime
 * cost, and every name here already lives in `./platform/projects-client`
 * (this is a convenience re-export, not a new surface).
 */
export type {
  // Projects
  KortixProject, KortixWorkspace,
  ProjectConfigSummary, WorkspaceConfigSummary,
  ProjectDetail, WorkspaceDetail,
  GatewayCatalogModel,
  ProjectLlmCatalogResponse, WorkspaceLlmCatalogResponse,
  // Accounts / IAM
  KortixAccount,
  AccountDetail,
  AccountBranding,
  AccountBrandingAssetKind,
  AccountBrandingState,
  AccountMember,
  AccountRole,
  ProjectRole,
  ProjectAccessMember, WorkspaceAccessMember,
  ProjectAccessRequest, WorkspaceAccessRequest,
  ProjectGroupGrant, WorkspaceGroupGrant,
  ProjectResourceGrant, WorkspaceResourceGrant,
  PendingProjectInvite, PendingWorkspaceInvite,
  PendingApproval,
  // Secrets / connectors
  ProjectSecret, WorkspaceSecret,
  ProjectGitConnection, WorkspaceGitConnection,
  ConnectorSharing,
  AdminConnector,
  ConnectorConfig,
  ConnectorDraftInput,
  ConnectorAuthDiscovery,
  ConnectorAuthCandidate,
  ExecutableConnectorAuth,
  DiscoveredAuthScheme,
  // Sessions
  ProjectSession, WorkspaceSession,
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
  ProjectCommit, WorkspaceCommit,
  ProjectCommitDetail, WorkspaceCommitDetail,
  ProjectCommitFile, WorkspaceCommitFile,
  ProjectBranch, WorkspaceBranch,
  ProjectBranchSession, WorkspaceBranchSession,
  // Triggers
  ProjectTrigger, WorkspaceTrigger,
  ProjectTriggerListing, WorkspaceTriggerListing,
  // Sandbox
  SandboxTemplate,
  ProjectSandboxHealth, WorkspaceSandboxHealth,
  ProjectSnapshotBuild, WorkspaceSnapshotBuild,
  // Gateway (LLM observability / budgets)
  GatewayLogRow,
  GatewayLogDetail,
  GatewayOverview,
  GatewayBudgetRow,
  GatewayKeyRow,
  // Tokens (CLI PATs)
  AccountToken,
  CreatedAccountToken,
  ProjectCliToken, WorkspaceCliToken,
  CreatedProjectCliToken, CreatedWorkspaceCliToken,
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
  ProjectGitToken, WorkspaceGitToken,
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
  // emit otherwise, e.g. apps/white-label/lumen `next build`).
  signUp,
  signInWithPassword,
  sendMagicLink,
  verifyOtp,
  signInWithProvider,
  exchangeCode,
  refreshSession,
  resetPassword,
  updatePassword,
  updateUserMetadata,
  signInWithSso,
  authMfa,
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
 * JSON inside).
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
// vendor type star (`export type * from './core/runtime/runtime-types'` inside
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
export * from './core/http/authenticated-request';
export * from './core/http/config';
export * from './core/http/feature-flags';
export * from './core/http/fresh-sessions';
export * from './core/http/impersonation';
export * from './core/http/instance-routes';
export * from './core/http/runtime-errors';
export * from './core/rest/platform-client';
export * from './core/rest/projects-client';
export * from './core/multi-agent/tool-data';
export * from './core/cache/persisted-query-cache';
export * from './core/files/image-cache';
export * from './core/attachments/limits';
export * from './core/attachments/prompt-attachments';
export * from './core/runtime/client';
export * from './core/runtime/attachment-part';
export * from './core/session';
export * from './core/session-log';
export * from './core/warm-session-pool';
export {
  createHttpSessionSyncController,
  loadHttpSessionHistory,
  type SessionSyncMessage,
} from './core/session-sync/session-sync-controller';
export * from './core/session-sync/saved-copy-store';
export {
  type EmptyConversationInput,
  type SavedSessionCopy,
  isEmptyConversation,
  readSavedSessionCopy,
  savedCopyEmptyRoot,
} from './core/session-sync/saved-transcript';
export * from './core/session/url';
/** The authenticated `/p/{externalId}/{port}` proxy URL of a session's sandbox port. */
export { getSandboxUrlForExternalId } from './core/session/server-store/url-helpers';
/** How this deployment addresses previews (`GET /v1/p/config`), cached per backend. */
export { loadPreviewUrlTemplate } from './core/session/preview-config';
export * from './core/stream/event-stream';
export * from './core/stream/fetch-sse';
export * from './core/turns';
export * from './transcript';

/**
 * Kortix Apps — the viewer, in the browser. An App hosted by Kortix is opened
 * by someone Kortix already authenticated, so `getToken: kortixAppViewerToken()`
 * is the whole of its auth. See `core/auth/app-viewer.ts`. (Kept across the
 * runtime-client revert — app-viewer has no runtime-client dependency.)
 */
export {
  fetchKortixAppViewer,
  kortixAppViewerToken,
  kortixToken,
  kortixBinding,
  clearKortixAppViewerCache,
  type KortixAppViewerSession,
  type KortixAppViewerOptions,
  type KortixTokenOptions,
  type KortixTokenFetcher,
  type KortixBinding,
  type KortixBindingOptions,
} from './core/auth/app-viewer';

/**
 * The signed-in Kortix member, on any runtime: one shape from the App gate,
 * the signed viewer header, or a Kortix-signed token, plus group- and
 * role-based access checks. See `core/auth/kortix-member.ts`.
 */
export {
  readKortixMember,
  requireKortixMember,
  verifyKortixToken,
  KortixMemberError,
  type KortixMember,
  type KortixMemberRequirement,
  type KortixMemberKeySet,
  type VerifyKortixTokenOptions,
} from './core/auth/kortix-member';

/**
 * The session composer's agent and model lists — framework-free, so web
 * (through the `./react` hooks) and mobile build the pickers and resolve what
 * to send with the same functions.
 *
 * Agents: `projectConfigAgentsToRuntimeAgents` (project detail → roster,
 * default first) → `composerSelectableAgents` (picker list) →
 * `resolveComposerAgent` (what runs, and whether send is allowed).
 * Models: `pickerProviderList` (raw sources → provider list) →
 * `flattenModels` → `createModelVisibility` + `modelInDefaultView` (default
 * view) → `resolveModelDefault` + `resolveComposerModel` (what runs).
 */
export {
  composerSelectableAgents,
  projectConfigAgentsToRuntimeAgents,
  resolveComposerAgent,
  type ComposerAgentReason,
  type ComposerAgentResolution,
} from './core/agents/composer-agents';
export { flattenModels, isOfferedModel, type FlatModel, type ModelOption } from './core/models/model-flatten';
export { modelRefToKey, type ModelKey } from './core/models/model-key';
export {
  createModelVisibility,
  modelInDefaultView,
  type ModelVisibilityPin,
} from './core/models/model-visibility';
export {
  pickerProviderList,
  type PickerProviderListInput,
} from './core/models/provider-selection';
/**
 * Provider connections: the catalogue rows, how each provider connects, which
 * providers a project's secrets connect, the list order, and who may use a new
 * connection. The web Models page and the TUI `/providers` screen read these.
 */
export {
  CODEX_AUTH_JSON_SECRET_NAME,
  FIRST_CLASS_PROVIDER_IDS,
  LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME,
  PROVIDER_SUBSCRIPTIONS,
  buildLlmProviderCatalog,
  connectionAccessSummary,
  connectionLabelOwnerName,
  connectionNeedsReconnection,
  connectionSharing,
  orderProviderRows,
  providerConnectMethod,
  providerConnectedVia,
  providerDisconnectPlan,
  providerIdsWithCredentials,
  providerKeyAccessFields,
  supportsPooledProviderKey,
  type ConnectionAccessChoice,
  type ConnectionAccessSummary,
  type LlmProviderCatalogSource,
  type LlmProviderEntry,
  type LlmProviderModel,
  type LlmProviderSource,
  type ProviderConnectMethod,
  type ProviderConnectedVia,
  type ProviderSubscription,
} from './core/models/provider-connections';
/**
 * Connectors: a connector's status and provider label, its accounts and who may
 * use each one, the Add account draft, sharing an account, the managed Connect
 * Link poll, and one-click OAuth for direct servers. The web connectors pages
 * and the TUI `/connectors` screen read these.
 */
export {
  connectorDerivedState,
  connectorDisplayName,
  connectorProviderLabel,
  connectorSetupStatus,
  connectorStatusTone,
  connectorUsable,
  isConnectorAuthChallenge,
  isManagedConnectorProvider,
  type ConnectorDerivedState,
  type ConnectorSetupStatus,
  type ConnectorStatusTone,
} from './core/connectors/connector-status';
export {
  connectionSharedWithEveryoneAfter,
  connectorAccountNeedsSignIn,
  connectorAccountVisibility,
  connectorAudienceVisibility,
  connectorConnectionRows,
  emptyWorkspaceConnectionSlot, emptyProjectConnectionSlot,
  grantConnectionAccess,
  listedConnectorAccounts,
  newConnectorAccountAudienceFor,
  newConnectorAccountGrantees,
  newConnectorAccountLabelTaken,
  newConnectorAccountReady,
  planConnectionShare,
  planPrivateConnectionShare,
  proposeConnectorAccountLabel,
  type ConnectionAudienceSelection,
  type ConnectionSharePlan,
  type ConnectorAccountVisibility,
  type NewConnectorAccountAudience,
  type NewConnectorAccountDraft,
} from './core/connectors/connector-accounts';
export {
  CONNECT_LINK_POLL_INTERVAL_MS,
  CONNECT_LINK_TIMEOUT_MS,
  DEFAULT_PROJECT_CONNECTION_LABEL, DEFAULT_WORKSPACE_CONNECTION_LABEL,
  connectLinkTimeoutMessage,
  connectLinkUrl,
  isSharedDefaultConnectConflict,
  pollConnectLinkFinalize,
  projectConnectionConnectRestDeps, workspaceConnectionConnectRestDeps,
  workspaceConnectionConnectSteps, projectConnectionConnectSteps,
  type ConnectLinkPollOptions,
  type ProjectConnectRoute, type WorkspaceConnectRoute,
  type ProjectConnectionConnectDeps, type WorkspaceConnectionConnectDeps,
} from './core/connectors/connect-link';
export {
  buildOAuth2ClientRegistrationInput,
  oauth2AutoConnectPlan,
  startConnectionOAuth2SignIn,
  waitForConnectionOAuth2,
  type ConnectionOAuth2SignInDeps,
  type ConnectionOAuth2SignInStart,
  type OAuth2AutoConnectPlan,
} from './core/connectors/connector-oauth2-sign-in';
export {
  latestPromptModel,
  resolveComposerModel,
  resolveModelDefault,
  sessionModelCandidates,
  sessionModelFallback,
  sessionPickStands,
  type ComposerModelResolution,
  type SessionModelFallback,
} from './core/models/composer-model';
