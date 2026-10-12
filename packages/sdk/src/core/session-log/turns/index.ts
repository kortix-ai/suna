/**
 * The block turn layer (P5.2b): the turn model over session-log blocks a transcript renders
 * from, in place of the v1 helpers over `MessageWithParts` (`core/turns`). Each name replaces:
 * - `groupLogIntoTurns`: `groupMessagesIntoTurns` + the host's `stabilizeTurns` (a turn keeps
 *   its identity) + `collectTurnParts` (`blocks`), with the derived fields `getTurnStatus`
 *   (`status`), `getTurnError`/`getTurnErrorDetails`/`getTurnErrorRawText` (`error`),
 *   `getTurnCost` (`cost`), `compactionTurnInfo` (`compaction`), `getShellModePart` (`shell`),
 *   `findLastTextPart` (`response`), `isAttachment` (`attachments`), `getWorkingState` +
 *   `resolveWorkingTurn` (`live`, `queued`), `hasRetryingAssistantTurn` (`retrying`), the host's
 *   `planAnchorMessageId` (`plan`) and `getChildSessionId` lookups (`threads`).
 * - `logTurnSegments`: `segmentTurn` + `groupShowSegments`. `splitLogTurnWork`: `splitTurnWork`.
 * - `logBurstSteps`: `mergeBurstSteps` + `stepLabel` + the host's `burstSteps`.
 * - `logActivityText`: `getTurnStatus` (the activity line).
 * - `logCallStatus`: the per-call status rule (new: a closure-rule block is open on a live turn).
 * - `promptLogMessage`: the host's synthetic row for a queued inbox prompt.
 * `getPermissionForTool(permissions, call.call_id)` and `getQuestionForTool` already take the
 * call id, so they serve a `ToolCallBlock` as they are.
 */
export {
  logActivityText,
  logBurstSteps,
  logTurnSegments,
  splitLogTurnWork,
  type LogBurstStep,
  type LogSegment,
  type LogSegmentOptions,
  type LogTurnWorkSplit,
} from './blocks';
export {
  groupLogIntoTurns,
  logCallStatus,
  promptLogMessage,
  type GroupLogTurnsOptions,
  type LogCallStatus,
  type LogCompaction,
  type LogTurn,
  type LogTurnError,
  type LogTurnStatus,
} from './turn';
