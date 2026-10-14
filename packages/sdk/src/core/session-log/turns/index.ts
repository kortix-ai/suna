/**
 * The block turn layer (P5.2b): the turn model over session-log blocks a transcript renders
 * from, in place of the v1 helpers over `MessageWithParts` (`core/turns`). Each name replaces:
 * - `sessionLogTurns`: `groupMessagesIntoTurns` + the host's `stabilizeTurns` (a turn keeps
 *   its identity) + `collectTurnParts` (`blocks`), with the derived fields `getTurnStatus`
 *   (`status`), `getTurnError`/`getTurnErrorDetails`/`getTurnErrorRawText` (`error`),
 *   `getTurnCost` (`cost`), `compactionTurnInfo` (`compaction`), `getShellModePart` (`shell`),
 *   `findLastTextPart` (`response`), `isAttachment` (`attachments`), `getWorkingState` +
 *   `resolveWorkingTurn` (`live`, `queued`), `hasRetryingAssistantTurn` (`retrying`), the host's
 *   `planAnchorMessageId` (`plan`) and `getChildSessionId` lookups (`threads`).
 * - `sessionLogTurnSegments`: `segmentTurn` + `groupShowSegments`. `splitSessionLogTurnWork`: `splitTurnWork`.
 * - `sessionLogBurstSteps`: `mergeBurstSteps` + `stepLabel` + the host's `burstSteps`.
 * - `sessionLogBurstSummary`: `burstSummary`. `sessionLogBurstWorkLabel`: `burstWorkLabel`. `sessionLogBurstRunning`: the host's `burstIsRunning`.
 * - `sessionLogOpenCall`: the host's `openCall` (the open shape of a closure-rule call).
 * - `sessionLogShowGroupCall`: the host's `mergeShowParts`. `sessionLogAnsweredQuestionCall`: the
 *   host's synthetic answered question part.
 * - `sessionLogActivityText`: `getTurnStatus` (the activity line).
 * - `classifySessionLogMessage`: `classifyTurn` (one message's `ClassifiedPart`s and error), for a
 *   host that renders `ClassifiedPart`s from blocks until P8.4.
 * - `sessionLogCallStatus`: the per-call status rule (new: a closure-rule block is open on a live turn).
 * - `sessionLogPromptMessage`: the host's synthetic row for a queued inbox prompt.
 * - `sessionLogRetrying`: `hasRetryingAssistantTurn` over a thread (the busy state's input).
 * - `sessionLogThreadMetrics`: a thread's cost, message counts and token totals (the context modal).
 * `getPermissionForTool(permissions, call.call_id)` and `getQuestionForTool` already take the
 * call id, so they serve a `ToolCallBlock` as they are.
 */
export {
  classifySessionLogMessage,
  sessionLogActivityText,
  sessionLogAnsweredQuestionCall,
  sessionLogBurstRunning,
  sessionLogBurstSteps,
  sessionLogBurstSummary,
  sessionLogBurstWorkLabel,
  sessionLogOpenCall,
  sessionLogShowGroupCall,
  sessionLogTurnSegments,
  splitSessionLogTurnWork,
  type SessionLogBurstStep,
  type SessionLogSegment,
  type SessionLogTurnWorkSplit,
} from './blocks';
export {
  sessionLogTurns,
  sessionLogCallStatus,
  sessionLogPromptMessage,
  sessionLogRetrying,
  type SessionLogTurnsOptions,
  type SessionLogCallStatus,
  type SessionLogCompaction,
  type SessionLogTurn,
  type SessionLogTurnError,
  type SessionLogTurnStatus,
} from './turn';
export { sessionLogThreadMetrics, type SessionLogThreadMetrics } from './metrics';
