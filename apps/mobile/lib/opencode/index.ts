/**
 * OpenCode Library — main entry point.
 *
 * Re-exports all types, hooks, stores, and utilities needed to build
 * the Computer mobile app's session-based UI.
 */

// Types
export * from './types';

/**
 * Turn grouping & helpers — framework-agnostic, one implementation shared with
 * apps/web through the SDK.
 *
 * This was `export * from '@kortix/sdk/turns'`. That subpath is a deprecated
 * alias, and the replacement cannot be a bare `export * from '@kortix/sdk'`:
 * the root carries the whole 844-name surface, which collides with the 34
 * opencode shapes `./types` declares and would also re-export the
 * ambient-runtime accessors (`getClient`, `getActiveOpenCodeUrl`, the pty
 * helpers) through `@/lib/opencode`.
 *
 * So the names are listed. This set is exactly what `@kortix/sdk/turns`
 * exported, so every existing `@/lib/opencode` importer resolves to the same
 * declaration it did before. Regenerate from
 * `packages/sdk/src/public-*-surface.snapshot.json` under the `"./turns"` key.
 */
export {
  COST_MARKUP,
  allDescendantIds,
  childMapByParent,
  classifyPart,
  classifyTurn,
  collectTurnParts,
  compareMessagesForDisplay,
  computeStatusFromPart,
  extractGatewayErrorDetails,
  findLastTextPart,
  formatCost,
  formatDuration,
  formatTokens,
  getAgentCardLabel,
  getAnsweredQuestionParts,
  getChildSessionError,
  getChildSessionId,
  getChildSessionToolParts,
  getDiagnostics,
  getDirectory,
  getFileWithDir,
  getFilename,
  getHiddenToolParts,
  getPartText,
  getPermissionForTool,
  getQuestionForTool,
  getRetryInfo,
  getRetryMessage,
  getSessionCost,
  getShellModePart,
  getToolInfo,
  getTurnCost,
  getTurnError,
  getTurnErrorDetails,
  getTurnStatus,
  getWorkingState,
  groupMessagesIntoTurns,
  hasDiffs,
  hasRetryingAssistantTurn,
  humanizeToolName,
  isAgentPart,
  isAttachment,
  isCompactionPart,
  isFilePart,
  isLastUserMessage,
  isPatchPart,
  isReasoningPart,
  isRetryableTurnError,
  isShellMode,
  isSnapshotPart,
  isTextPart,
  isToolPart,
  isToolPartHidden,
  normalizeToolName,
  relativizePath,
  shellExitCode,
  shouldHideResponsePart,
  shouldShowToolPart,
  sortSessions,
  splitUserParts,
  stripAnsi,
  toolInfo,
  toolViewModel,
  turnHasSteps,
  unwrapError,
} from '@kortix/sdk';
export type {
  ClassifiedAgentPart,
  ClassifiedCompactionPart,
  ClassifiedFilePart,
  ClassifiedPart,
  ClassifiedPatchPart,
  ClassifiedReasoningPart,
  ClassifiedRetryPart,
  ClassifiedSnapshotPart,
  ClassifiedStepPart,
  ClassifiedSubtaskPart,
  ClassifiedTextPart,
  ClassifiedToolPart,
  ClassifiedTurn,
  ClassifiedUnknownPart,
  Diagnostic,
  DiffLine,
  DiffLineType,
  GatewayAttemptFailure,
  GatewayErrorDetails,
  HiddenToolRef,
  MessageInfoLike,
  MessageWithPartsLike,
  ModelCostRates,
  ModelCostTierRates,
  ModelPricingLookup,
  OpenTurnMessageLike,
  PartLike,
  PartWithMessage,
  QuestionItem,
  QuestionOption,
  RequestWithToolLike,
  RetryInfo,
  SearchMatch,
  SessionStatusLike,
  TodoItem,
  TokenUsageLike,
  ToolCategory,
  ToolInfo,
  ToolInfoEntry,
  ToolPartLike,
  ToolStateLike,
  ToolStatus,
  ToolView,
  ToolViewModel,
  TurnCostInfo,
  TurnError,
  TurnLike,
  WebSearchResultItem,
} from '@kortix/sdk';

// The transcript store, the SSE event stream and the session-sync hook used to
// be re-exported from here. All three are gone: `useSession` from
// `@kortix/sdk/react` owns the session lifecycle, and the SDK's own store
// (`useSessionStateStore`) holds the messages. What remains in this directory
// is the turn-rendering helpers and the React Native SSE wire.
