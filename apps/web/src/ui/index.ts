/**
 * Shared session UI primitives — framework-agnostic.
 *
 * Import from '@/ui' for types, turn grouping, part helpers, and status text.
 * The turn helpers live in `@kortix/sdk` (single implementation shared
 * with mobile); this barrel re-exports them alongside the web view-model types.
 *
 * IMPORTANT: No React / DOM / framework imports in this folder.
 */

export * from './types';

/**
 * The framework-free turn/part helpers, from the canonical `@kortix/sdk` root.
 *
 * This was `export * from '@kortix/sdk/turns'`. That subpath is a deprecated
 * alias, but the replacement cannot be a bare `export * from '@kortix/sdk'`:
 * the root carries the whole 844-name surface, which (a) collides with the web
 * view-model types in `./types` and (b) would re-expose `getClient`,
 * `getActiveOpenCodeUrl`, `createKortixPty`, `getKortixPtyWebSocketUrl` and
 * `removeKortixPty` through `@/ui` — the ambient-runtime accessors that
 * eslint's no-restricted-imports forbids precisely because they resolve a
 * runtime from global state instead of from a session.
 *
 * So the names are listed. This set is exactly what `@kortix/sdk/turns`
 * exported, so every existing `@/ui` importer resolves to the same
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
