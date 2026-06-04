/**
 * OpenCode Session Types
 *
 * These mirror the types from @opencode-ai/sdk but are defined locally
 * to avoid pulling in the full SDK dependency for mobile.
 */

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
    created: number; // unix ms
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

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: SessionPart[];
  createdAt: number;
  system?: boolean;
  time: {
    created: number;
    completed?: number;
  };
  metadata?: Record<string, any>;
}

export type SessionPart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
}

export interface ToolPart {
  type: 'tool';
  id: string;
  tool: string;
  state: 'pending' | 'running' | 'completed' | 'error';
  input: Record<string, any>;
  output?: string;
  metadata?: Record<string, any>;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface FilePart {
  type: 'file';
  mediaType: string;
  filename: string;
  url: string;
}

export type SessionStatus = 'idle' | 'running' | 'error';

export interface SessionStatusMap {
  [sessionId: string]: SessionStatus;
}

export interface SessionEvent {
  type: string;
  properties: Record<string, any>;
}
