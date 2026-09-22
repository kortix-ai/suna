/**
 * OpenCode Session Types for Mobile — framework-agnostic.
 *
 * These types mirror the Computer frontend's ui/types.ts but define the SDK types
 * locally instead of importing from @opencode-ai/sdk (which is web-only).
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface FileDiff {
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

/**
 * The wire shapes come from the SDK, not from local copies.
 *
 * This file used to redeclare `Message`, the whole `Part` union and every
 * member of it. They were structural twins of the OpenCode types the SDK
 * already exports, which TypeScript treats as unrelated — so every transcript
 * component rejected the data `useSession` actually produces, and the gap was
 * bridged with `as any` casts at the boundary.
 */
export type {
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolState,
  FilePart,
  AgentPart,
  SnapshotPart,
  PatchPart,
  StepStartPart,
  StepFinishPart,
} from '@kortix/sdk';


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

export interface QuestionOption {
  label: string;
  description?: string;
}

/** Each element is an array of selected labels for that question index. */
export type QuestionAnswer = string[];

// ---------------------------------------------------------------------------
// Agents, Models, Providers
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  name: string;
  description?: string;
}

export interface Model {
  id: string;
  name: string;
  providerID: string;
  default?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  models: Model[];
}

export interface Command {
  name: string;
  description?: string;
  arguments?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// View-model types
// ---------------------------------------------------------------------------

/**
 * The transcript shapes come from the SDK, not from a local copy.
 *
 * These used to be declared here over this file's own `Message`/`Part`
 * mirrors. `useSession` hands back the SDK's `MessageWithParts`, so a local
 * structural twin made every transcript component reject the very data the
 * hook produces — two identical shapes TypeScript treats as unrelated.
 */
export type { MessageWithParts } from '@kortix/sdk';

export interface Turn {
  userMessage: SdkMessageWithParts;
  assistantMessages: SdkMessageWithParts[];
}

import type { MessageWithParts as SdkMessageWithParts } from '@kortix/sdk';

export type { Diagnostic, RetryInfo, ToolInfo, TurnCostInfo } from '@kortix/sdk';

export const PERMISSION_LABELS: Record<string, string> = {
  bash: 'Run command',
  edit: 'Edit file',
  write: 'Write file',
  read: 'Read file',
  webfetch: 'Fetch URL',
  mcp: 'Use MCP tool',
  doom_loop: 'Repeated tool call',
};
