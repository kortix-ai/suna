'use client';

import { useSandboxConnectionStore } from '../../state/sandbox-connection-store';
import { getActiveOpenCodeUrl } from '../../state/server-store/active';
import { useCurrentRuntime } from '../use-current-runtime';
import { activeServerKey } from './shared';
import type {
  Session,
  Message,
  Part,
  Agent,
  Command,
  Project,
  SessionStatus,
  PermissionRule,
  Model,
  McpStatus,
  Path as PathInfo,
  ProviderListResponse as SdkProviderListResponse,
  Worktree,
  WorktreeCreateInput,
  WorktreeRemoveInput,
  WorktreeResetInput,
} from '../../runtime/wire-types';

// ============================================================================
// Re-export SDK types for consumers
// ============================================================================

export type { Session, Message, Part, Agent, Command, Project, SessionStatus, PermissionRule, Model, McpStatus, PathInfo, Worktree, WorktreeCreateInput, WorktreeRemoveInput, WorktreeResetInput };

/**
 * Shape returned by `client.session.messages()`:
 * `Array<{ info: Message; parts: Part[] }>`
 */
export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

/**
 * Provider list response — matches the actual SDK response from `client.provider.list()`.
 * The SDK's inline model shape differs from the `Model` type, so we use the SDK's
 * response type directly.
 */
export type ProviderListResponse = SdkProviderListResponse;

/**
 * Prompt part (input to send message).
 * Supports text, file references, and agent/mode mentions.
 */
export type PromptPart =
  | { type: 'text'; text: string; id?: string }
  | { type: 'file'; mime: string; url: string; filename?: string; source?: { text: { value: string; start: number; end: number }; type: 'file'; path: string } }
  | { type: 'agent'; name: string; source?: { value: string; start: number; end: number } };

export interface SendMessageOptions {
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  /** Session's working directory — lets opencode resolve project-scoped
   * (`.opencode/agent/*.md`) agents when `agent` names one of them. */
  directory?: string;
}

/**
 * Skill type from `client.app.skills()`.
 */
export interface Skill {
  name: string;
  description: string;
  location: string;
  content: string;
}

/**
 * Tool list item from `client.tool.list()`.
 */
export interface ToolListItem {
  id: string;
  description: string;
  parameters: unknown;
}

// ============================================================================
// Query Keys
// ============================================================================

export const opencodeKeys = {
  all: ['opencode'] as const,
  sessions: (serverId?: string) => ['opencode', 'sessions', serverId ?? activeServerKey()] as const,
  session: (id: string) => ['opencode', 'session', id] as const,
  messages: (sessionId: string) => ['opencode', 'session', sessionId, 'messages'] as const,
  agents: () => ['opencode', 'agents', activeServerKey()] as const,
  toolIds: () => ['opencode', 'tool-ids', activeServerKey()] as const,
  tools: (providerID: string, modelID: string) => ['opencode', 'tools', providerID, modelID, activeServerKey()] as const,
  skills: () => ['opencode', 'skills', activeServerKey()] as const,
  projects: () => ['opencode', 'projects', activeServerKey()] as const,
  currentProject: () => ['opencode', 'project', 'current', activeServerKey()] as const,
  commands: () => ['opencode', 'commands', activeServerKey()] as const,
  providers: () => ['opencode', 'providers', activeServerKey()] as const,
  pathInfo: () => ['opencode', 'path-info', activeServerKey()] as const,
  mcpStatus: () => ['opencode', 'mcp-status', activeServerKey()] as const,
  worktrees: () => ['opencode', 'worktrees', activeServerKey()] as const,
};

export function useOpenCodeRuntimeReady() {
  const connectedHealthy = useSandboxConnectionStore(
    (s) => s.status === 'connected' && s.healthy === true,
  );
  // The health gate can flip true BEFORE the runtime URL is pinned — billing
  // envs seed healthy=true optimistically, ahead of useSession's
  // setCurrentRuntime(). Firing an opencode query in that gap makes getClient()
  // throw "Server URL not ready — sandbox is still loading". So also require a
  // resolved URL: subscribe to the runtime url (recomputes the instant the
  // runtime pins) and fall back to getActiveOpenCodeUrl(), which covers the
  // self-hosted default-sandbox case where the store url stays null.
  const runtimeUrl = useCurrentRuntime((s) => s.url);
  const hasUrl = !!(runtimeUrl || getActiveOpenCodeUrl());
  return connectedHealthy && hasUrl;
}
