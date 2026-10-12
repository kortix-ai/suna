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
 * - `sessionLogActivityText`: `getTurnStatus` (the activity line).
 * - `sessionLogCallStatus`: the per-call status rule (new: a closure-rule block is open on a live turn).
 * - `sessionLogPromptMessage`: the host's synthetic row for a queued inbox prompt.
 * `getPermissionForTool(permissions, call.call_id)` and `getQuestionForTool` already take the
 * call id, so they serve a `ToolCallBlock` as they are.
 */
export {
  sessionLogActivityText,
  sessionLogBurstSteps,
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
  type SessionLogTurnsOptions,
  type SessionLogCallStatus,
  type SessionLogCompaction,
  type SessionLogTurn,
  type SessionLogTurnError,
  type SessionLogTurnStatus,
} from './turn';
