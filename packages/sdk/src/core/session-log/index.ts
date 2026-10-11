/**
 * The public names of the session-log types (`kortix.session/2`), vendored in
 * `types.ts`. Types and three constants, no `zod`: validators stay in `@kortix/api-contract`.
 *
 * Not exported, because the name is too generic for a package root: `Role`,
 * `Usage`, `Pending`, `Ext`, `Producer`, `SchemaRef`, `BlockBase`. Read them from
 * the record: `SessionLogMessage['usage']`, `SessionLog['pending']['questions'][number]`.
 *
 * Not exported, because no client reads them: `AdapterCapabilities`, `CapabilityFeatures`
 * and `ExportCursor` are daemon-side adapter state (capability manifests, incremental-export
 * cursors). They stay in `types.ts` for byte-equality. Adding an export later is additive;
 * removing one is a major.
 */
export {
  KNOWN_TOOL_KINDS,
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  type AttachmentBlock,
  type CompactionBlock,
  type CompactionLayoutEntry,
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
