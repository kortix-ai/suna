'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '@/lib/opencode-sdk';
import { useOpenCodeCompactionStore } from '@/stores/opencode-compaction-store';
import { useSyncStore } from '@/stores/opencode-sync-store';
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
} from '@opencode-ai/sdk/v2/client';

// ============================================================================
// Re-export SDK types for consumers
// ============================================================================

export type { Session, Message, Part, Agent, Command, Project, SessionStatus, PermissionRule, Model, McpStatus, PathInfo, Worktree, WorktreeCreateInput, WorktreeRemoveInput, WorktreeResetInput };

// Re-export filtered agents hook for UI agent selectors
export { useVisibleAgents } from './use-visible-agents';

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
  sessions: () => ['opencode', 'sessions'] as const,
  session: (id: string) => ['opencode', 'session', id] as const,
  messages: (sessionId: string) => ['opencode', 'session', sessionId, 'messages'] as const,
  agents: () => ['opencode', 'agents'] as const,
  toolIds: () => ['opencode', 'tool-ids'] as const,
  tools: (providerID: string, modelID: string) => ['opencode', 'tools', providerID, modelID] as const,
  skills: () => ['opencode', 'skills'] as const,
  projects: () => ['opencode', 'projects'] as const,
  currentProject: () => ['opencode', 'project', 'current'] as const,
  commands: () => ['opencode', 'commands'] as const,
  providers: () => ['opencode', 'providers'] as const,
  pathInfo: () => ['opencode', 'path-info'] as const,
  mcpStatus: () => ['opencode', 'mcp-status'] as const,
  worktrees: () => ['opencode', 'worktrees'] as const,
};

// ============================================================================
// Helper: unwrap SDK response (data / error)
// ============================================================================

function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error) {
    const err = result.error as any;
    const status = (result.response as Response | undefined)?.status;
    // Try to extract the most specific error message from the SDK response
    const msg =
      err?.data?.message ||
      err?.message ||
      err?.error ||
      (typeof err === 'string' ? err : null) ||
      (typeof err === 'object' ? JSON.stringify(err) : null) ||
      (status ? `Server returned ${status}` : 'SDK request failed');
    throw new Error(msg);
  }
  return result.data as T;
}

// ============================================================================
// Session Hooks
// ============================================================================

function getLSCache<T>(key: string): T | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function setLSCache(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable
  }
}

const LS_SESSIONS = 'kortix_cache_sessions';
const LS_AGENTS = 'kortix_cache_agents';
const LS_COMMANDS = 'kortix_cache_commands';
const LS_PROVIDERS = 'kortix_cache_providers';

export function useOpenCodeSessions() {
  return useQuery<Session[]>({
    queryKey: opencodeKeys.sessions(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.list({ limit: 10000 });
      const sessions = unwrap(result);
      const sorted = sessions.sort((a: Session, b: Session) => b.time.updated - a.time.updated);
      setLSCache(LS_SESSIONS, sorted);
      return sorted;
    },
    placeholderData: () => getLSCache<Session[]>(LS_SESSIONS),
    staleTime: 5 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10000),
  });
}

export function useOpenCodeSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useQuery<Session>({
    queryKey: opencodeKeys.session(sessionId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.get({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: !!sessionId,
    staleTime: Infinity,
    placeholderData: () => {
      const sessions = queryClient.getQueryData<Session[]>(opencodeKeys.sessions());
      return sessions?.find((s) => s.id === sessionId);
    },
  });
}

export function useCreateOpenCodeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: { directory?: string; title?: string } | void) => {
      const client = getClient();
      const opts = options || {};
      const result = await client.session.create({
        directory: opts.directory,
        title: opts.title,
      });
      return unwrap(result);
    },
    onSuccess: (newSession) => {
      // Surgically insert into cache — SSE session.created will also fire
      // but this gives instant UI feedback. Dedup to avoid duplicate keys.
      const session = newSession as Session;
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return [session];
        const idx = old.findIndex((s) => s.id === session.id);
        if (idx >= 0) {
          const next = [...old];
          next[idx] = session;
          return next.sort((a, b) => b.time.updated - a.time.updated);
        }
        return [session, ...old].sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(opencodeKeys.session(session.id), session);
    },
  });
}

export function useDeleteOpenCodeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
      const result = await client.session.delete({ sessionID: sessionId });
      unwrap(result);
      return sessionId;
    },
    onSuccess: (sessionId) => {
      // Surgically remove from cache — SSE session.deleted will also fire
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        return old.filter((s) => s.id !== sessionId);
      });
      queryClient.removeQueries({ queryKey: opencodeKeys.session(sessionId) });
      queryClient.removeQueries({ queryKey: opencodeKeys.messages(sessionId) });
    },
  });
}

export function useUpdateOpenCodeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      title,
      archived,
    }: {
      sessionId: string;
      title?: string;
      archived?: boolean;
    }) => {
      const client = getClient();
      const body: { title?: string; time?: { archived?: number } } = {};
      if (title !== undefined) body.title = title;
      if (archived !== undefined) body.time = { archived: archived ? Date.now() : 0 };
      const result = await client.session.update({ sessionID: sessionId, ...body });
      return unwrap(result);
    },
    onSuccess: (updatedSession) => {
      // Surgically update cache — SSE session.updated will also fire
      const session = updatedSession as Session;
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        const idx = old.findIndex((s) => s.id === session.id);
        if (idx < 0) return old;
        const next = [...old];
        next[idx] = session;
        return next.sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(opencodeKeys.session(session.id), session);
    },
  });
}

export function useOpenCodeSessionDiff(sessionId: string) {
  return useQuery({
    queryKey: ['opencode', 'session-diff', sessionId],
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.diff({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: !!sessionId,
    staleTime: Infinity,
  });
}

export function useOpenCodeSessionTodo(sessionId: string) {
  return useQuery({
    queryKey: ['opencode', 'session-todo', sessionId],
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.todo({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: !!sessionId,
    staleTime: Infinity,
  });
}

/**
 * Get messages for a session.
 *
 * CONSOLIDATED: Now reads from the Zustand sync store (single source of truth)
 * instead of making its own independent React Query fetch. The sync store is
 * populated by useSessionSync on mount and kept live by SSE events.
 *
 * Previously this was an independent React Query hook with its own queryFn that
 * called client.session.messages() — duplicating the exact same fetch that
 * useSessionSync already makes. This caused 2x /session/{id}/message requests
 * on every session navigation.
 *
 * Returns a shape compatible with the old UseQueryResult<MessageWithParts[]>
 * for backward compatibility with consumers (session-layout, tool-renderers,
 * snapshot-dialog, session-diff-viewer).
 */
/**
 * Message cache for useOpenCodeMessages — prevents creating new array references
 * on every render. Same pattern as buildMessages() in use-session-sync.ts.
 * Without this, the Zustand selector returns a new array from .map() on every
 * call, breaking useSyncExternalStore's Object.is check → infinite re-render.
 */
const MSG_HOOK_CACHE_MAX = 20;
const msgHookCache = new Map<
  string,
  {
    msgs: Message[] | undefined;
    partRefs: (Part[] | undefined)[];
    result: MessageWithParts[];
  }
>();

function touchMsgHookCache(sessionId: string) {
  const entry = msgHookCache.get(sessionId);
  if (entry) {
    msgHookCache.delete(sessionId);
    msgHookCache.set(sessionId, entry);
  }
  if (msgHookCache.size > MSG_HOOK_CACHE_MAX) {
    const oldest = msgHookCache.keys().next().value;
    if (oldest) msgHookCache.delete(oldest);
  }
}

const EMPTY_MSGS: MessageWithParts[] = [];

function buildMsgsForHook(
  sessionId: string,
  msgs: Message[] | undefined,
  parts: Record<string, Part[]>,
): MessageWithParts[] {
  if (!msgs || msgs.length === 0) return EMPTY_MSGS;

  const cached = msgHookCache.get(sessionId);
  if (cached && cached.msgs === msgs) {
    let same = cached.partRefs.length === msgs.length;
    if (same) {
      for (let i = 0; i < msgs.length; i++) {
        if (parts[msgs[i].id] !== cached.partRefs[i]) {
          same = false;
          break;
        }
      }
    }
    if (same) return cached.result;
  }

  const partRefs: (Part[] | undefined)[] = [];
  const result: MessageWithParts[] = [];
  for (const info of msgs) {
    const pa = parts[info.id];
    partRefs.push(pa);
    result.push({ info, parts: pa ?? [] });
  }
  msgHookCache.set(sessionId, { msgs, partRefs, result });
  touchMsgHookCache(sessionId);
  return result;
}

export function useOpenCodeMessages(sessionId: string) {
  // Select via a referentially-stable selector that uses an external cache.
  // getMessages() in the store creates new arrays via .map() on every call,
  // which breaks useSyncExternalStore → infinite loop. buildMsgsForHook()
  // returns the same reference if nothing changed for this session.
  const messages = useSyncStore((s) =>
    buildMsgsForHook(sessionId, s.messages[sessionId], s.parts),
  );
  const isLoading = !useSyncStore((s) => sessionId in s.messages);

  return {
    data: messages.length > 0 ? messages : undefined,
    isLoading,
    isError: false,
    error: null,
    refetch: async () => ({ data: messages } as any),
  };
}

// ============================================================================
// Prompt / Abort Hooks
// ============================================================================

/**
 * Generate a monotonic ascending ID compatible with the server's Identifier.ascending().
 * Server format: prefix + "_" + 12-char hex timestamp + 14-char random base62 = prefix_<26 chars>
 * Server validates: z.string().startsWith("msg") for messages, "prt" for parts.
 */
let lastIdTimestamp = 0;
let idCounter = 0;
export function ascendingId(prefix: 'msg' | 'prt' = 'msg'): string {
  const now = Date.now();
  if (now !== lastIdTimestamp) {
    lastIdTimestamp = now;
    idCounter = 0;
  }
  idCounter++;
  const encoded = BigInt(now) * BigInt(0x1000) + BigInt(idCounter);
  const hex = encoded.toString(16).padStart(12, '0').slice(0, 12);
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let rand = '';
  for (let i = 0; i < 14; i++) rand += chars[Math.floor(Math.random() * 62)];
  return `${prefix}_${hex}${rand}`;
}

export function useSendOpenCodeMessage() {
  return useMutation({
    mutationFn: async ({
      sessionId,
      parts,
      options,
      messageID,
    }: {
      sessionId: string;
      parts: PromptPart[];
      options?: SendMessageOptions;
      messageID?: string;
    }) => {
      const mappedParts = parts.map((p) => {
        if (p.type === 'file') return { type: 'file' as const, mime: p.mime, url: p.url, filename: p.filename, source: p.source };
        if (p.type === 'agent') return { type: 'agent' as const, name: p.name, source: p.source };
        return { type: 'text' as const, text: p.text };
      });
      const payload = {
        sessionID: sessionId,
        parts: mappedParts,
        ...(messageID && { messageID }),
        ...(options?.model && { model: options.model }),
        ...(options?.agent && { agent: options.agent }),
        ...(options?.variant && { variant: options.variant }),
      };

      // Match OpenCode exactly: use session.prompt() (blocking endpoint).
      // The call blocks until the AI finishes, but we fire-and-forget from
      // the UI side (handleSend doesn't await the mutation result).
      // SSE events drive all incremental UI updates via the sync store.
      const client = getClient();
      const result = await client.session.prompt(payload as any);
      if (result.error) {
        const err = result.error as any;
        throw new Error(err?.data?.message || err?.message || 'Failed to send message');
      }
    },
  });
}

export function useAbortOpenCodeSession() {
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
      const result = await client.session.abort({ sessionID: sessionId });
      unwrap(result);
      // After abort succeeds, the SSE stream should deliver session.idle event.
      // If the UI stays stuck, it means the SSE event wasn't received/processed.
      // The optimistic idle status we set in handleStop should handle this, but
      // if for some reason the abort HTTP call returned but SSE didn't update,
      // we force-refresh the session status from the server.
      try {
        const statusResult = await client.session.status();
        const statuses = statusResult.data as Record<string, any>;
        const serverStatus = statuses[sessionId];
        if (serverStatus && serverStatus.type !== 'idle') {
          // Server still thinks we're busy - update the store with server's view
          // This can happen if SSE events were missed
          useSyncStore.getState().setStatus(sessionId, serverStatus);
        }
      } catch {
        // Non-critical — SSE will eventually deliver the correct status
      }
    },
    retry: 2,
    retryDelay: 300,
    onError: () => {},
  });
}

// ============================================================================
// Agent Hooks
// ============================================================================

export function useOpenCodeAgents() {
  return useQuery<Agent[]>({
    queryKey: opencodeKeys.agents(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.agents();
      const data = unwrap(result);
      const agents: Agent[] = Array.isArray(data) ? data : Object.values(data as Record<string, Agent>);
      setLSCache(LS_AGENTS, agents);
      return agents;
    },
    placeholderData: () => getLSCache<Agent[]>(LS_AGENTS),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useOpenCodeAgent(agentName: string) {
  return useQuery<Agent | undefined>({
    queryKey: [...opencodeKeys.agents(), agentName],
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.agents();
      const agents = unwrap(result);
      return agents.find((a: Agent) => a.name === agentName);
    },
    enabled: !!agentName,
    staleTime: Infinity,
  });
}

// ============================================================================
// Tool Hooks
// ============================================================================

export function useOpenCodeToolIds() {
  return useQuery<string[]>({
    queryKey: opencodeKeys.toolIds(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.tool.ids();
      return unwrap(result);
    },
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useOpenCodeTools(providerID: string, modelID: string) {
  return useQuery<ToolListItem[]>({
    queryKey: opencodeKeys.tools(providerID, modelID),
    queryFn: async () => {
      const client = getClient();
      const result = await client.tool.list({ provider: providerID, model: modelID });
      return unwrap(result) as ToolListItem[];
    },
    enabled: !!providerID && !!modelID,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

// ============================================================================
// Skill Hooks
// ============================================================================

export function useOpenCodeSkills() {
  return useQuery<Skill[]>({
    queryKey: opencodeKeys.skills(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.skills();
      return unwrap(result) as Skill[];
    },
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

// ============================================================================
// Project Hooks
// ============================================================================

export function useOpenCodeProjects() {
  return useQuery<Project[]>({
    queryKey: opencodeKeys.projects(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.project.list();
      return unwrap(result);
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

export function useOpenCodeCurrentProject() {
  return useQuery<Project>({
    queryKey: opencodeKeys.currentProject(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.project.current();
      return unwrap(result);
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

// ============================================================================
// Path Info Hook
// ============================================================================

export function useOpenCodePathInfo() {
  return useQuery<PathInfo>({
    queryKey: opencodeKeys.pathInfo(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.path.get();
      return unwrap(result);
    },
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

// ============================================================================
// Command Hooks
// ============================================================================

export function useOpenCodeCommands() {
  return useQuery<Command[]>({
    queryKey: opencodeKeys.commands(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.command.list();
      const commands = unwrap(result);
      setLSCache(LS_COMMANDS, commands);
      return commands;
    },
    placeholderData: () => getLSCache<Command[]>(LS_COMMANDS),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

export function useExecuteOpenCodeCommand() {
  return useMutation({
    mutationFn: async ({
      sessionId,
      command,
      args,
    }: {
      sessionId: string;
      command: string;
      args?: string;
    }) => {
      const client = getClient();
      const result = await client.session.command({
        sessionID: sessionId,
        command,
        arguments: args || '',
      });
      unwrap(result);
    },
    // CRITICAL: Disable retry for commands. The /command endpoint blocks until
    // the agent finishes, which can take minutes (e.g. onboarding). If a proxy
    // timeout or network error kills the connection, TanStack Query's default
    // global retry would re-POST the command, causing it to execute twice on
    // the server. Commands are non-idempotent — each POST creates a new
    // execution. Never retry them.
    retry: false,
  });
}

// ============================================================================
// Summarize Hook
// ============================================================================

export function useSummarizeOpenCodeSession() {
  const queryClient = useQueryClient();
  const startCompaction = useOpenCodeCompactionStore((s) => s.startCompaction);
  const stopCompaction = useOpenCodeCompactionStore((s) => s.stopCompaction);
  return useMutation({
    mutationFn: async (params: { sessionId: string; providerID?: string; modelID?: string }) => {
      const client = getClient();

      let { providerID, modelID } = params;

      // 1. Try config default model
      if (!providerID || !modelID) {
        try {
          const configResult = await client.global.config.get();
          const config = configResult.data as any;
          if (config?.model) {
            const parts = (config.model as string).split('/');
            if (parts.length >= 2) {
              providerID = providerID || parts[0];
              modelID = modelID || parts.slice(1).join('/');
            }
          }
        } catch {
          // ignore
        }
      }

      // 2. Try to get model from the session's latest assistant message
      if (!providerID || !modelID) {
        try {
          const msgs = await client.session.messages({ sessionID: params.sessionId });
          const allMsgs = (msgs.data ?? []) as Array<{ info: { role: string; providerID?: string; modelID?: string } }>;
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            const m = allMsgs[i].info;
            if (m.role === 'assistant' && m.providerID && m.modelID) {
              providerID = providerID || m.providerID;
              modelID = modelID || m.modelID;
              break;
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. Try first available provider/model from provider list
      if (!providerID || !modelID) {
        try {
          const providerResult = await client.provider.list();
          const providers = providerResult.data as any;
          if (providers && typeof providers === 'object') {
            for (const [pid, providerInfo] of Object.entries(providers)) {
              const models = (providerInfo as any)?.models;
              if (models && typeof models === 'object') {
                const firstModelId = Object.keys(models)[0];
                if (firstModelId) {
                  providerID = pid;
                  modelID = firstModelId;
                  break;
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }

      if (!providerID || !modelID) {
        throw new Error('No model available for compaction. Please configure a model in settings.');
      }

      const result = await client.session.summarize({
        sessionID: params.sessionId,
        providerID,
        modelID,
      });
      unwrap(result);
      return params.sessionId;
    },
    onMutate: ({ sessionId }) => {
      startCompaction(sessionId);
    },
    onError: (_err, { sessionId }) => {
      stopCompaction(sessionId);
    },
    onSuccess: (_sessionId) => {
      // SSE session.compacted event handles rehydration of messages and
      // session data. No need to invalidate here — the event handler in
      // use-opencode-events.ts fetches messages + session for that ID.
    },
  });
}

// ============================================================================
// Fork Hook
// ============================================================================

/**
 * Fork a session at a specific message point.
 * Creates a new session that branches off from the given message.
 * Returns the newly created Session.
 */
export function useForkSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      messageId,
      directory,
      workspace,
    }: {
      sessionId: string;
      messageId?: string;
      directory?: string;
      workspace?: string;
    }) => {
      const client = getClient();
      const result = await client.session.fork({
        sessionID: sessionId,
        ...(messageId && { messageID: messageId }),
        ...(directory && { directory }),
        ...(workspace && { workspace }),
      });
      return unwrap(result) as Session;
    },
    onSuccess: (newSession) => {
      // Insert forked session into cache — SSE session.created will also fire.
      // Dedup to avoid duplicate keys in the session list.
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return [newSession];
        const idx = old.findIndex((s) => s.id === newSession.id);
        if (idx >= 0) {
          const next = [...old];
          next[idx] = newSession;
          return next.sort((a, b) => b.time.updated - a.time.updated);
        }
        return [newSession, ...old].sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(opencodeKeys.session(newSession.id), newSession);
    },
  });
}



// ============================================================================
// Init Hook — analyze project and create AGENTS.md (via /init command)
// ============================================================================

export function useInitSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      const client = getClient();
      const result = await client.session.command({
        sessionID: sessionId,
        command: 'init',
        arguments: '',
      });
      if (result.error) {
        const err = result.error as any;
        throw new Error(err?.data?.message || err?.message || 'Failed to initialize project');
      }
      return sessionId;
    },
    onSuccess: (sessionId) => {
      // SSE events handle session updates. Just refetch messages for this session
      // since /init creates new messages.
      queryClient.refetchQueries({ queryKey: opencodeKeys.messages(sessionId) });
    },
    // Suppress global error handler — caller handles errors via onError callback
    onError: () => {},
    // Same rationale as useExecuteOpenCodeCommand — /command blocks until done,
    // retrying on timeout would duplicate execution.
    retry: false,
  });
}

// ============================================================================
// Provider Hooks
// ============================================================================

export function useOpenCodeProviders() {
  return useQuery<ProviderListResponse>({
    queryKey: opencodeKeys.providers(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.provider.list();
      const providers = unwrap(result);
      setLSCache(LS_PROVIDERS, providers);
      return providers;
    },
    placeholderData: () => getLSCache<ProviderListResponse>(LS_PROVIDERS),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

// ============================================================================
// MCP Status Hook
// ============================================================================

export function useOpenCodeMcpStatus() {
  return useQuery<Record<string, McpStatus>>({
    queryKey: opencodeKeys.mcpStatus(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.mcp.status();
      return unwrap(result) as Record<string, McpStatus>;
    },
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

// ============================================================================
// Share / Unshare Hooks
// ============================================================================

export function useShareSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
      const result = await client.session.share({ sessionID: sessionId });
      return unwrap(result) as Session;
    },
    onSuccess: (updatedSession) => {
      // Surgically update cache with share info
      queryClient.setQueryData(opencodeKeys.session(updatedSession.id), updatedSession);
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        const idx = old.findIndex((s) => s.id === updatedSession.id);
        if (idx < 0) return old;
        const next = [...old];
        next[idx] = updatedSession;
        return next;
      });
    },
  });
}

export function useUnshareSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
      const result = await client.session.unshare({ sessionID: sessionId });
      return unwrap(result) as Session;
    },
    onSuccess: (updatedSession) => {
      // Surgically update cache with unshare info
      queryClient.setQueryData(opencodeKeys.session(updatedSession.id), updatedSession);
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        const idx = old.findIndex((s) => s.id === updatedSession.id);
        if (idx < 0) return old;
        const next = [...old];
        next[idx] = updatedSession;
        return next;
      });
    },
  });
}

// ============================================================================
// Part Edit / Delete Hooks
// ============================================================================

/**
 * Update a message part (e.g. edit text content).
 * Uses `client.part.update()` — available in SDK v2.
 * SSE `message.part.updated` events handle cache updates automatically.
 */
export function useUpdatePart() {
  return useMutation({
    mutationFn: async ({
      sessionId,
      messageId,
      partId,
      part,
    }: {
      sessionId: string;
      messageId: string;
      partId: string;
      part: Partial<Part>;
    }) => {
      const client = getClient();
      const result = await client.part.update({
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
        part: part as Part,
      });
      return unwrap(result) as Part;
    },
    // SSE message.part.updated handles cache updates via sync store.
    // No onSuccess needed — eliminates unnecessary message refetch.
  });
}

/**
 * Delete a message part.
 * Uses `client.part.delete()` — available in SDK v2.
 * SSE `message.part.removed` events handle cache updates automatically.
 */
export function useDeletePart() {
  return useMutation({
    mutationFn: async ({
      sessionId,
      messageId,
      partId,
    }: {
      sessionId: string;
      messageId: string;
      partId: string;
    }) => {
      const client = getClient();
      const result = await client.part.delete({
        sessionID: sessionId,
        messageID: messageId,
        partID: partId,
      });
      return unwrap(result);
    },
    // SSE message.part.removed handles cache updates via sync store.
    // No onSuccess needed — eliminates unnecessary message refetch.
  });
}

// ============================================================================
// File Search (direct SDK call, not a hook)
// ============================================================================

let mentionFileIndexCache:
  | {
      files: string[];
      fetchedAt: number;
    }
  | undefined;

let mentionDirScanCache:
  | {
      files: string[];
      fetchedAt: number;
    }
  | undefined;

export async function findOpenCodeFiles(query: string): Promise<string[]> {
  const client = getClient();
  const normalizedQuery = query.trim();
  const ql = normalizedQuery.toLowerCase();

  const rankFile = (path: string): number => {
    const lower = path.toLowerCase();
    const base = lower.split('/').pop() ?? lower;
    const depth = path.split('/').length - 1;
    if (ql.length === 0) return depth;
    if (base === ql) return 0 + depth * 0.01;
    if (base.startsWith(ql)) return 10 + depth * 0.01;
    if (base.includes(ql)) return 20 + depth * 0.01;
    if (lower.startsWith(ql)) return 30 + depth * 0.01;
    if (lower.includes(ql)) return 40 + depth * 0.01;
    return 1000 + depth;
  };

  const fileMatchesQuery = (path: string): boolean => {
    if (ql.length === 0) return true;
    const lower = path.toLowerCase();
    if (lower.includes(ql)) return true;
    const base = lower.split('/').pop() ?? lower;
    return base.includes(ql);
  };

  const readEntries = async (request: Promise<{ data?: unknown; error?: unknown }>): Promise<string[]> => {
    try {
      const result = await request;
      const entries = unwrap(result);
      if (!Array.isArray(entries)) return [];
      const normalized: string[] = [];
      for (const entry of entries) {
        if (typeof entry === 'string' && entry.length > 0) {
          normalized.push(entry);
          continue;
        }

        if (entry && typeof entry === 'object') {
          const maybePath = (entry as { path?: unknown }).path;
          const maybeType = (entry as { type?: unknown }).type;
          if (typeof maybePath === 'string' && maybePath.length > 0) {
            if (maybeType === 'directory' && !maybePath.endsWith('/')) {
              normalized.push(`${maybePath}/`);
            } else {
              normalized.push(maybePath);
            }
          }
        }
      }
      return normalized;
    } catch {
      return [];
    }
  };

  const [strictFiles, broadResults] = await Promise.all([
    readEntries(client.find.files({ query: normalizedQuery, type: 'file', limit: 80 })),
    readEntries(client.find.files({ query: normalizedQuery, limit: 80 })),
  ]);

  const fileMatches = new Set<string>();
  const directoryMatches: string[] = [];

  for (const entry of [...strictFiles, ...broadResults]) {
    if (entry.endsWith('/')) {
      directoryMatches.push(entry);
      continue;
    }
    fileMatches.add(entry);
  }

  if (fileMatches.size < 20 && normalizedQuery.length > 0 && directoryMatches.length > 0) {
    const expandedDirs = directoryMatches.slice(0, 6);
    const dirChildren = await Promise.all(
      expandedDirs.map(async (dir) => {
        const path = dir.endsWith('/') ? dir.slice(0, -1) : dir;
        const children = await readEntries(client.file.list({ path }));
        return children
          .filter((child) => !child.endsWith('/'))
          .filter((child) => fileMatchesQuery(child));
      }),
    );

    for (const group of dirChildren) {
      for (const child of group) {
        fileMatches.add(child);
      }
    }
  }

  // Explicit root scan fallback for @mentions.
  // Some backends under-return root-level files via find.files(query).
  if (normalizedQuery.length > 0 && fileMatches.size < 20) {
    const [rootWorkspace, rootEmpty] = await Promise.all([
      readEntries(client.file.list({ path: '/workspace' } as any)),
      readEntries(client.file.list({ path: '' } as any)),
    ]);
    for (const entry of [...rootWorkspace, ...rootEmpty]) {
      if (entry.endsWith('/')) continue;
      if (fileMatchesQuery(entry)) fileMatches.add(entry);
    }
  }

  // Directory scan fallback for @mentions.
  // Builds a lightweight index from root + first-level directories (e.g.
  // /workspace/Desktop, /workspace/test) to catch substring matches that
  // find.files(query) may miss.
  if (normalizedQuery.length > 0 && fileMatches.size < 20) {
    const now = Date.now();
    const cacheFresh = mentionDirScanCache && now - mentionDirScanCache.fetchedAt < 60_000;

    if (!cacheFresh) {
      const roots = await Promise.all([
        readEntries(client.file.list({ path: '/workspace' } as any)),
        readEntries(client.file.list({ path: '' } as any)),
      ]);
      const rootEntries = Array.from(new Set([...roots[0], ...roots[1]]));

      const fileSet = new Set<string>();
      const firstLevelDirs = rootEntries
        .filter((entry) => entry.endsWith('/'))
        .map((entry) => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
        .slice(0, 80);

      for (const entry of rootEntries) {
        if (!entry.endsWith('/')) fileSet.add(entry);
      }

      const childLists = await Promise.all(
        firstLevelDirs.map((dir) => readEntries(client.file.list({ path: dir } as any))),
      );

      for (const children of childLists) {
        for (const child of children) {
          if (!child.endsWith('/')) fileSet.add(child);
        }
      }

      mentionDirScanCache = {
        files: Array.from(fileSet),
        fetchedAt: now,
      };
    }

    for (const path of mentionDirScanCache?.files ?? []) {
      if (fileMatchesQuery(path)) fileMatches.add(path);
    }
  }

  // Fallback index for @mentions: some backends return sparse results for
  // incremental filename fragments. Build/cached a broad file index and filter
  // client-side to keep mention search responsive and tolerant.
  if (normalizedQuery.length > 0 && fileMatches.size < 10) {
    const now = Date.now();
    const cacheFresh =
      mentionFileIndexCache && now - mentionFileIndexCache.fetchedAt < 60_000;
    if (!cacheFresh) {
      const [indexStrict, indexBroad] = await Promise.all([
        readEntries(client.find.files({ query: '', type: 'file', limit: 2000 })),
        readEntries(client.find.files({ query: '', limit: 2000 })),
      ]);
      const indexSet = new Set<string>();
      for (const entry of [...indexStrict, ...indexBroad]) {
        if (!entry.endsWith('/')) indexSet.add(entry);
      }
      mentionFileIndexCache = {
        files: Array.from(indexSet),
        fetchedAt: now,
      };
    }

    for (const path of mentionFileIndexCache?.files ?? []) {
      if (fileMatchesQuery(path)) fileMatches.add(path);
    }
  }

  return Array.from(fileMatches)
    .sort((a, b) => rankFile(a) - rankFile(b) || a.localeCompare(b))
    .slice(0, 20);
}

// ============================================================================
// Permission & Question Reply (direct SDK calls, not hooks)
// ============================================================================

export async function replyToPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<void> {
  const client = getClient();
  const result = await client.permission.reply({ requestID: requestId, reply, message });
  unwrap(result);
}

export async function replyToQuestion(
  requestId: string,
  answers: string[][],
): Promise<void> {
  const client = getClient();
  const result = await client.question.reply({ requestID: requestId, answers });
  unwrap(result);
}

export async function rejectQuestion(requestId: string): Promise<void> {
  const client = getClient();
  const result = await client.question.reject({ requestID: requestId });
  unwrap(result);
}

// useSessionPolling was removed — SSE reconnects within <3s making 2s HTTP
// polling redundant. All session status + message updates are driven by SSE
// events via the sync store. See SSE-FIRST-MIGRATION-PLAN.md Phase 1d.
