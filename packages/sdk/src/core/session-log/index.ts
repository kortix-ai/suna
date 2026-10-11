/**
 * The public names of the session-log types (`kortix.session/2`), vendored in
 * `types.ts`. Types only, no `zod`: validators stay in `@kortix/api-contract`.
 *
 * Not exported, because the name is too generic for a package root: `Role`,
 * `Usage`, `Pending`, `Ext`, `Producer`, `SchemaRef`, `BlockBase`. Read them from
 * the record: `SessionLogMessage['usage']`, `SessionLog['pending']['questions'][number]`.
 */
export {
  KNOWN_TOOL_KINDS,
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  type AdapterCapabilities,
  type AttachmentBlock,
  type CapabilityFeatures,
  type CompactionBlock,
  type CompactionLayoutEntry,
  type ExportCursor,
  type GradeCounts,
  type HarnessBlock,
  type KnownToolKind,
  type ModelRef,
  type ReasoningBlock,
  type RestoreGrade,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogThread,
  type StepBlock,
  type SubtaskBlock,
  type TextBlock,
  type ThreadInteraction,
  type ToolCallBlock,
  type ToolResultContent,
} from './types';

// `Todo` and `ToolKind` are already public names of this package (the transcript
// todo and the turn tool kind), so the session-log ones carry the record prefix.
export type { Todo as SessionLogTodo, ToolKind as SessionLogToolKind } from './types';
