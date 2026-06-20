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
} from '@opencode-ai/sdk/v2/client';

export type FileDiff = Omit<import('@opencode-ai/sdk/v2/client').SnapshotFileDiff, 'patch'> & {
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
  info: import('@opencode-ai/sdk/v2/client').Message;
  parts: import('@opencode-ai/sdk/v2/client').Part[];
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

/** Icon + title + subtitle for a tool part, used in BasicTool trigger & task child summaries. */
export interface ToolInfo {
  icon: string;
  title: string;
  subtitle?: string;
}

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

/** LSP diagnostic from tool metadata. */
export interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number; // 1 = Error, 2 = Warning
}

// ---------------------------------------------------------------------------
// Cost & token types
// ---------------------------------------------------------------------------

export interface TurnCostInfo {
  /** Total cost in USD */
  cost: number;
  /** Total tokens */
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// ---------------------------------------------------------------------------
// Retry info
// ---------------------------------------------------------------------------

export interface RetryInfo {
  attempt: number;
  message: string;
  /** When the retry will happen (unix ms) */
  next: number;
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
