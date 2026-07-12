export type JsonRecord = Record<string, any>;

export interface Message {
  id: string;
  role: string;
  parentID?: string;
  sessionID?: string;
  time: { created: number; updated?: number; completed?: number; archived?: number };
  error?: unknown;
  [key: string]: any;
}

export interface AssistantMessage extends Message {
  role: 'assistant';
}

export interface UserMessage extends Message {
  role: 'user';
}

interface BasePart {
  id: string;
  type: any;
  messageID?: string;
  sessionID?: string;
  [key: string]: any;
}

export interface TextPart extends BasePart {
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export interface ReasoningPart extends BasePart {
  type: 'reasoning';
  text: string;
}

export interface ToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  [key: string]: any;
}

export interface ToolStatePending extends ToolState {
  status: 'pending';
}

export interface ToolStateRunning extends ToolState {
  status: 'running';
}

export interface ToolStateCompleted extends ToolState {
  status: 'completed';
}

export interface ToolStateError extends ToolState {
  status: 'error';
  error: string;
}

export interface ToolPart extends BasePart {
  type: 'tool';
  tool: string;
  callID: string;
  state: ToolState;
}

export interface FilePart extends BasePart {
  type: 'file';
  mime: string;
  url: string;
  filename: string;
}

export interface AgentPart extends BasePart {
  type: 'agent';
  name: string;
}

export interface SubtaskPart extends BasePart {
  type: 'subtask';
  description: string;
  agent: string;
  prompt: string;
  model?: { providerID: string; modelID: string };
}

export interface StepStartPart extends BasePart {
  type: 'step-start';
  snapshot?: string;
}

export interface StepFinishPart extends BasePart {
  type: 'step-finish';
  snapshot?: string;
  reason?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
    [key: string]: any;
  };
}

export interface SnapshotPart extends BasePart {
  type: 'snapshot';
  snapshot: string;
}

export interface SnapshotFileDiff {
  file: string;
  patch?: string;
  before?: string;
  after?: string;
  [key: string]: any;
}

export interface PatchPart extends BasePart {
  type: 'patch';
  hash: string;
  files: string[];
}

export interface RetryPart extends BasePart {
  type: 'retry';
  attempt: number;
  error?: unknown;
  time: { created: number };
}

export interface CompactionPart extends BasePart {
  type: 'compaction';
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | AgentPart
  | SubtaskPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | RetryPart
  | CompactionPart;

export interface Session {
  id: string;
  title: string;
  parentID?: string;
  time: { created: number; updated: number; archived?: number };
  [key: string]: any;
}

export interface Agent {
  name: string;
  id?: string;
  [key: string]: any;
}

export interface Command {
  name: string;
  id?: string;
  [key: string]: any;
}

export interface Project {
  id?: string;
  path?: string;
  [key: string]: any;
}

export interface Path {
  root?: string;
  cwd?: string;
  [key: string]: any;
}

export interface Model {
  id?: string;
  name?: string;
  cost?: { input?: number; output?: number; cache_read?: number };
  capabilities?: Record<string, any>;
  [key: string]: any;
}

export interface Provider {
  id: string;
  name: string;
  models: Record<string, Model>;
  source?: string;
  [key: string]: any;
}

export interface ProviderListResponse {
  all?: Provider[];
  connected?: string[];
  default?: Record<string, string>;
  providers?: Provider[];
  [key: string]: any;
}

export type Config = JsonRecord;
export type McpStatus = JsonRecord;
export type Pty = JsonRecord;
export type PermissionRule = JsonRecord;
export type PermissionRuleset = JsonRecord;
export type SessionStatus = JsonRecord & { type: string };
export type Worktree = JsonRecord;
export type WorktreeCreateInput = JsonRecord;
export type WorktreeRemoveInput = JsonRecord;
export type WorktreeResetInput = JsonRecord;

export interface PermissionRequest {
  id: string;
  sessionID: string;
  tool?: { messageID: string; callID: string };
  [key: string]: any;
}

export interface QuestionOption {
  label: string;
  description?: string;
  [key: string]: any;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
  [key: string]: any;
}

export type QuestionAnswer = string[];

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
  [key: string]: any;
}

export type Todo = JsonRecord;
export type Event = JsonRecord;

export interface RuntimeResult<T = any> {
  data?: T;
  error?: unknown;
  response?: Response;
}

export type RuntimeMethod<T = any> = (...args: any[]) => Promise<RuntimeResult<T>>;

export interface RuntimeClient {
  global: {
    config: Record<string, RuntimeMethod>;
    dispose: RuntimeMethod;
    health: RuntimeMethod;
    event: (opts: { signal: AbortSignal; sseDefaultRetryDelay?: number; sseMaxRetryDelay?: number }) => Promise<{ stream: AsyncIterable<unknown> }>;
  };
  session: Record<string, RuntimeMethod>;
  provider: {
    list: RuntimeMethod;
    auth: RuntimeMethod;
    oauth: {
      authorize: RuntimeMethod;
      callback: RuntimeMethod;
    };
    [key: string]: any;
  };
  auth: Record<string, RuntimeMethod>;
  instance: Record<string, RuntimeMethod>;
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
