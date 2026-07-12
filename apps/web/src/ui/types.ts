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
} from '@kortix/sdk/runtime-client';

export type FileDiff = Omit<import('@kortix/sdk/runtime-client').SnapshotFileDiff, 'patch'> & {
  patch?: string;
  before?: string;
  after?: string;
};

// ---------------------------------------------------------------------------
// View-model types
// ---------------------------------------------------------------------------

/**
 * A message with its pre-resolved parts — the shape returned by
 * a native harness message projection.
 */
export interface MessageWithParts {
  info: import('@kortix/sdk/runtime-client').Message;
  parts: import('@kortix/sdk/runtime-client').Part[];
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
