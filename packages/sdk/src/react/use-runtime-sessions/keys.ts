'use client';

import { useSandboxConnectionStore } from '../../browser/stores/sandbox-connection-store';
import { getActiveRuntimeUrl } from '../../core/session/server-store/active';
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
  /** Session's working directory — lets the runtime resolve project-scoped
   * native agents when `agent` names one of them. */
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

export const runtimeKeys = {
  all: ['runtime'] as const,
  sessions: (serverId?: string) => ['runtime', 'sessions', serverId ?? activeServerKey()] as const,
  session: (id: string) => ['runtime', 'session', id] as const,
  messages: (sessionId: string) => ['runtime', 'session', sessionId, 'messages'] as const,
  agents: () => ['runtime', 'agents', activeServerKey()] as const,
  toolIds: () => ['runtime', 'tool-ids', activeServerKey()] as const,
  tools: (providerID: string, modelID: string) => ['runtime', 'tools', providerID, modelID, activeServerKey()] as const,
  skills: () => ['runtime', 'skills', activeServerKey()] as const,
  projects: () => ['runtime', 'projects', activeServerKey()] as const,
  currentProject: () => ['runtime', 'project', 'current', activeServerKey()] as const,
  commands: () => ['runtime', 'commands', activeServerKey()] as const,
  providers: () => ['runtime', 'providers', activeServerKey()] as const,
  pathInfo: () => ['runtime', 'path-info', activeServerKey()] as const,
  mcpStatus: () => ['runtime', 'mcp-status', activeServerKey()] as const,
  worktrees: () => ['runtime', 'worktrees', activeServerKey()] as const,
};

export function useRuntimeReady() {
  const connectedHealthy = useSandboxConnectionStore(
    (s) => s.status === 'connected' && s.healthy === true,
  );
  // The health gate can flip true BEFORE the runtime URL is pinned — billing
  // envs seed healthy=true optimistically, ahead of useSession's
  // setCurrentRuntime(). Firing an opencode query in that gap makes getClient()
  // throw "Server URL not ready — sandbox is still loading". So also require a
  // resolved URL: subscribe to the runtime url (recomputes the instant the
  // runtime pins) and fall back to getActiveRuntimeUrl(), which covers the
  // self-hosted default-sandbox case where the store url stays null.
  const runtimeUrl = useCurrentRuntime((s) => s.url);
  const hasUrl = !!(runtimeUrl || getActiveRuntimeUrl());
  return connectedHealthy && hasUrl;
}
