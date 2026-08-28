/**
 * Shared session UI types — framework-agnostic.
 *
 * These types are consumed by both web (React) and mobile (React Native)
 * frontends. They re-export from the SDK and add view-model types on top.
 *
 * IMPORTANT: No React / DOM / framework imports allowed in this folder.
 */

// ---------------------------------------------------------------------------
// SDK re-exports
// ---------------------------------------------------------------------------

export type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  FilePart,
  AgentPart,
  SubtaskPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  RetryPart,
  CompactionPart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  PermissionRequest,
  QuestionRequest,
  QuestionInfo,
  QuestionOption,
  QuestionAnswer,
  SessionStatus,
  Agent,
  Command,
  Project,
  Model,
  Provider,
  Todo,
  SnapshotFileDiff,
} from '@kortix/sdk';

export type FileDiff = Omit<import('@kortix/sdk').SnapshotFileDiff, 'patch'> & {
  patch?: string;
  before?: string;
  after?: string;
};

// ---------------------------------------------------------------------------
// View-model types
// ---------------------------------------------------------------------------

/**
 * A message with its pre-resolved parts — the shape returned by
 * `session.messages()`.
 */
export interface MessageWithParts {
  info: import('@kortix/sdk').Message;
  parts: import('@kortix/sdk').Part[];
}

/**
 * A "turn" groups a user message with all its assistant responses.
 * This is the primary rendering unit for the chat history.
 */
export interface Turn {
  userMessage: MessageWithParts;
  assistantMessages: MessageWithParts[];
}

// ---------------------------------------------------------------------------
// Tool rendering types (shared between web & mobile tool renderers)
// ---------------------------------------------------------------------------

export type { Diagnostic, RetryInfo, ToolInfo, TurnCostInfo } from '@kortix/sdk/turns';

/** Structured trigger data for the BasicTool wrapper. */
export interface TriggerTitle {
  title: string;
  subtitle?: string;
  args?: string[];
  /**
   * Line-count summary rendered beside the subtitle as `+N −N` (DiffStat on
   * web). Plain data, not a node — this folder is framework-free, and the
   * numbers mean the same thing on every surface.
   */
  stat?: { additions: number; deletions: number };
  /**
   * The subtitle repeats text the OPEN body already shows, so the row drops it
   * once it is expanded.
   *
   * A closed row is the only place that text appears, so it stays there. Open,
   * it is the same string twice — and the trigger's copy is the worse one: it
   * is truncated to one line, so a long value disagrees with the full one
   * directly beneath it.
   *
   * Opt-in per call, not a blanket rule, because most subtitles are NOT
   * repeated by the body: a `pty` row's terminal id, for instance, appears
   * nowhere in the buffer it opens, and hiding it would lose the only thing
   * saying WHICH terminal this is. Set it where the body genuinely echoes the
   * subtitle, and leave it off everywhere else.
   */
  hideSubtitleWhenOpen?: boolean;
}

/** A file entry in an apply_patch tool part's metadata. */
export interface ApplyPatchFile {
  filePath: string;
  relativePath: string;
  type: 'add' | 'update' | 'delete' | 'move';
  diff: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  movePath?: string;
}

// ---------------------------------------------------------------------------
// Permission labels (shared between web & mobile)
// ---------------------------------------------------------------------------

export const PERMISSION_LABELS: Record<string, string> = {
  bash: 'Run command',
  edit: 'Edit file',
  write: 'Write file',
  read: 'Read file',
  webfetch: 'Fetch URL',
  mcp: 'Use MCP tool',
  doom_loop: 'Repeated tool call',
};
