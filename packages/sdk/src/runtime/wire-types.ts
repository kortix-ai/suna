export type JsonRecord = Record<string, any>;

export type Message = any;
export type AssistantMessage = any;
export type UserMessage = any;
export type Part = any;
export type TextPart = any;
export type ReasoningPart = any;
export type ToolPart = any;
export type FilePart = any;
export type AgentPart = any;
export type SubtaskPart = any;
export type StepStartPart = any;
export type StepFinishPart = any;
export type SnapshotPart = any;
export type PatchPart = any;
export type RetryPart = any;
export type CompactionPart = any;
export type ToolState = any;
export type ToolStatePending = any;
export type ToolStateRunning = any;
export type ToolStateCompleted = any;
export type ToolStateError = any;
export type SnapshotFileDiff = any;
export type Session = any;
export type Agent = any;
export type Command = any;
export type Project = any;
export type Path = any;
export type Model = any;
export type Provider = any;
export type ProviderListResponse = any;
export type Config = any;
export type McpStatus = any;
export type Pty = any;
export type PermissionRule = any;
export type PermissionRuleset = any;
export type SessionStatus = any;
export type Worktree = any;
export type WorktreeCreateInput = any;
export type WorktreeRemoveInput = any;
export type WorktreeResetInput = any;
export type PermissionRequest = any;
export type QuestionRequest = any;
export type QuestionInfo = any;
export type QuestionOption = any;
export type QuestionAnswer = any;
export type Todo = any;
export type Event = any;

export interface RuntimeResult<T = any> {
  data?: T;
  error?: unknown;
  response?: Response;
}

export type RuntimeMethod<T = any> = (...args: any[]) => Promise<RuntimeResult<T>>;

export interface RuntimeClient {
  global: {
    config: Record<string, RuntimeMethod>;
    health: RuntimeMethod;
    event: (opts: { signal: AbortSignal; sseDefaultRetryDelay?: number; sseMaxRetryDelay?: number }) => Promise<{ stream: AsyncIterable<unknown> }>;
  };
  session: Record<string, RuntimeMethod>;
  provider: Record<string, RuntimeMethod>;
  app: Record<string, RuntimeMethod>;
  command: Record<string, RuntimeMethod>;
  permission: Record<string, RuntimeMethod>;
  question: Record<string, RuntimeMethod>;
  file: Record<string, RuntimeMethod>;
  find: Record<string, RuntimeMethod>;
  part: Record<string, RuntimeMethod>;
  project: Record<string, RuntimeMethod>;
  path: Record<string, RuntimeMethod>;
  tool: Record<string, RuntimeMethod>;
  mcp: {
    status: RuntimeMethod;
    add: RuntimeMethod;
    connect: RuntimeMethod;
    disconnect: RuntimeMethod;
    auth: Record<string, RuntimeMethod>;
  };
  pty: Record<string, RuntimeMethod>;
}
