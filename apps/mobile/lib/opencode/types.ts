/**
 * OpenCode Session Types for Mobile — framework-agnostic.
 *
 * These types mirror the Computer frontend's ui/types.ts but define the SDK types
 * locally instead of importing from @opencode-ai/sdk (which is web-only).
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface Session {
  id: string;
  slug: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: FileDiff[];
  };
  share?: { url: string };
  title: string;
  version: string;
  time: {
    created: number;
    updated: number;
    compacting?: number;
    archived?: number;
  };
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

interface Message {
  id: string;
  role: 'user' | 'assistant';
  sessionID: string;
  parentID?: string;
  error?: string;
  time: {
    created: number;
    completed?: number;
  };
  system?: boolean;
  metadata?: Record<string, any>;
}

export type AssistantMessage = Message & { role: 'assistant'; error?: string };

// ---------------------------------------------------------------------------
// Parts (polymorphic)
// ---------------------------------------------------------------------------

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

export interface TextPart {
  type: 'text';
  id: string;
  text: string;
  synthetic?: boolean;
}

export interface ReasoningPart {
  type: 'reasoning';
  id: string;
  text: string;
}

export interface ToolPart {
  type: 'tool';
  id: string;
  callID: string;
  tool: string;
  state: ToolState;
  input: Record<string, any>;
  time?: { start?: number; end?: number };
}

type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

interface ToolStatePending {
  status: 'pending';
  metadata?: Record<string, any>;
}

interface ToolStateRunning {
  status: 'running';
  metadata?: Record<string, any>;
}

interface ToolStateCompleted {
  status: 'completed';
  output?: string;
  metadata?: Record<string, any>;
}

interface ToolStateError {
  status: 'error';
  error: string;
  metadata?: Record<string, any>;
}

export interface FilePart {
  type: 'file';
  id: string;
  mime: string;
  filename: string;
  url: string;
}

interface AgentPart {
  type: 'agent';
  id: string;
  agentID: string;
  agentName?: string;
}

interface SubtaskPart {
  type: 'subtask';
  id: string;
}

interface StepStartPart {
  type: 'step-start';
  id: string;
}

export interface StepFinishPart {
  type: 'step-finish';
  id: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

interface SnapshotPart {
  type: 'snapshot';
  id: string;
}

interface PatchPart {
  type: 'patch';
  id: string;
}

interface RetryPart {
  type: 'retry';
  id: string;
}

interface CompactionPart {
  type: 'compaction';
  id: string;
}

// ---------------------------------------------------------------------------
// Session status
// ---------------------------------------------------------------------------

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'retry'; attempt: number; message: string; next: number }
  | { type: 'error'; error: string };

// ---------------------------------------------------------------------------
// Permissions & Questions
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  id: string;
  sessionID: string;
  tool?: { messageID: string; callID: string };
  permission: string;
  input: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  tool?: { messageID: string; callID: string };
  questions: QuestionInfo[];
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

interface QuestionOption {
  label: string;
  description?: string;
}

/** Each element is an array of selected labels for that question index. */
export type QuestionAnswer = string[];

// ---------------------------------------------------------------------------
// Agents, Models, Providers
// ---------------------------------------------------------------------------

interface Agent {
  id: string;
  name: string;
  description?: string;
}

interface Model {
  id: string;
  name: string;
  providerID: string;
  default?: boolean;
}

interface Provider {
  id: string;
  name: string;
  models: Model[];
}

interface Command {
  name: string;
  description?: string;
  arguments?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// View-model types
// ---------------------------------------------------------------------------

export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

export interface Turn {
  userMessage: MessageWithParts;
  assistantMessages: MessageWithParts[];
}

export interface ToolInfo {
  icon: string;
  title: string;
  subtitle?: string;
}

export interface TurnCostInfo {
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface RetryInfo {
  attempt: number;
  message: string;
  next: number;
}
