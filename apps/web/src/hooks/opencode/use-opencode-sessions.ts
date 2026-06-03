'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '@/lib/opencode-sdk';
import { isOpenCodeConfigInvalidError } from '@/lib/opencode-errors';
import { useOpenCodeCompactionStore } from '@/stores/opencode-compaction-store';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useSyncStore } from '@/stores/opencode-sync-store';
import { useServerStore } from '@/stores/server-store';
import { ScopedCache } from '@/lib/storage/managed-storage';
import type {
  Session,
  Message,
  Part,
  Agent,
  Command,
  ProviderListResponse as SdkProviderListResponse,
} from '@opencode-ai/sdk/v2/client';

// ============================================================================
// Re-export SDK types for consumers
// ============================================================================

export type { Session, Message, Part, Agent, Command };

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

// ============================================================================
// Query Keys
// ============================================================================

/**
 * Active sandbox/server id, used to scope per-sandbox caches.
 *
 * Each project session is its OWN sandbox (session_id == sandbox_id), but the
 * OpenCode SDK client + caches are global. Without scoping, switching from
 * session A to B would show A's data under B — which is why the code used to
 * NUKE the entire opencode cache on every switch. That nuke is exactly what
 * made returning to an already-open session "reload".
 *
 * By appending the server id to per-sandbox cache keys, every sandbox's data
 * coexists in the cache, so returning to a warm session is instant and we no
 * longer need to tear anything down. Appended at the END so existing prefix
 * matches (e.g. invalidate `['opencode','sessions']`) still hit.
 *
 * `session(id)` / `messages(id)` stay global: opencode session ids are unique
 * per sandbox, so they never collide across sandboxes.
 */
function activeServerKey(): string {
  try {
    return useServerStore.getState().activeServerId ?? 'none';
  } catch {
    return 'none';
  }
}

export const opencodeKeys = {
  all: ['opencode'] as const,
  sessions: (serverId?: string) => ['opencode', 'sessions', serverId ?? activeServerKey()] as const,
  session: (id: string) => ['opencode', 'session', id] as const,
  messages: (sessionId: string) => ['opencode', 'session', sessionId, 'messages'] as const,
  agents: () => ['opencode', 'agents', activeServerKey()] as const,
  toolIds: () => ['opencode', 'tool-ids', activeServerKey()] as const,
  skills: () => ['opencode', 'skills', activeServerKey()] as const,
  projects: () => ['opencode', 'projects', activeServerKey()] as const,
  currentProject: () => ['opencode', 'project', 'current', activeServerKey()] as const,
  commands: () => ['opencode', 'commands', activeServerKey()] as const,
  providers: () => ['opencode', 'providers', activeServerKey()] as const,
  pathInfo: () => ['opencode', 'path-info', activeServerKey()] as const,
  worktrees: () => ['opencode', 'worktrees', activeServerKey()] as const,
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

// localStorage placeholder caches are per-sandbox too — scope by active server
// id so re-opening a warm session paints its OWN last data, never the previous
// sandbox's. Scoping lives in the helpers so every call site inherits it.
//
// These are backed by ScopedCache, which caps each family to its N
// most-recently-used scopes. That cap is the whole point: the default scope is
// the EPHEMERAL per-sandbox server id, so without a cap every new session would
// leak a fresh `kortix_cache_*:<serverId>` blob forever and eventually blow the
// localStorage quota (which then crashes whatever store writes next). The cache
// is disposable — a miss just refetches — so small caps are safe.
const LS_SESSIONS = 'kortix_cache_sessions';
const LS_AGENTS = 'kortix_cache_agents';
const LS_COMMANDS = 'kortix_cache_commands';
const LS_PROVIDERS = 'kortix_cache_providers';

// Session/command lists are keyed per ephemeral sandbox — keep only the few
// most-recent sandboxes warm. Agents are keyed per directory (+ global), which
// is a small, stable space, so it gets more headroom. Providers are global.
const sessionsCache = new ScopedCache<Session[]>(LS_SESSIONS, 4);
const agentsCache = new ScopedCache<Agent[]>(LS_AGENTS, 8);
const commandsCache = new ScopedCache<Command[]>(LS_COMMANDS, 4);
const providersCache = new ScopedCache<ProviderListResponse>(LS_PROVIDERS, 2);

const cacheByFamily: Record<string, ScopedCache<any>> = {
  [LS_SESSIONS]: sessionsCache,
  [LS_AGENTS]: agentsCache,
  [LS_COMMANDS]: commandsCache,
  [LS_PROVIDERS]: providersCache,
};

function getLSCache<T>(family: string, scope?: string): T | undefined {
  return cacheByFamily[family]?.get(scope ?? activeServerKey()) as T | undefined;
}

function setLSCache(family: string, value: unknown, scope?: string): void {
  cacheByFamily[family]?.set(scope ?? activeServerKey(), value);
}

/**
 * Stable cache scope for data that does NOT vary per sandbox. The default
 * scope is the ephemeral per-sandbox server id, which is correct for
 * session-specific data (session lists collide across sandboxes) but wrong for
 * platform/project-level data like the model list and the agent roster: those
 * are identical across every sandbox, yet a per-server key guarantees a cache
 * MISS on every brand-new session (new sandbox → new server id → never seen).
 * Keying them here instead lets a fresh session paint its pickers from cache on
 * the first frame, before the sandbox is even up — killing the visible pop-in.
 */
const CACHE_SCOPE_GLOBAL = 'global';

export function useOpenCodeRuntimeReady() {
  return useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);
}

export function useOpenCodeSessions() {
  const runtimeReady = useOpenCodeRuntimeReady();
  // Subscribe to the active server so the query key recomputes the instant the
  // sandbox switches — returning to a warm session hits its cached list rather
  // than refetching from scratch.
  const serverId = useServerStore((s) => s.activeServerId) ?? undefined;
  return useQuery<Session[]>({
    queryKey: opencodeKeys.sessions(serverId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.list({ limit: 10000 });
      const sessions = unwrap(result);
      const sorted = sessions.sort((a: Session, b: Session) => b.time.updated - a.time.updated);
      setLSCache(LS_SESSIONS, sorted);
      return sorted;
    },
    placeholderData: () => getLSCache<Session[]>(LS_SESSIONS),
    enabled: runtimeReady,
    staleTime: 5 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) =>
      !isOpenCodeConfigInvalidError(error) && failureCount < 3,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10000),
  });
}

export function useOpenCodeSession(sessionId: string) {
  const queryClient = useQueryClient();
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Session>({
    queryKey: opencodeKeys.session(sessionId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.get({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: runtimeReady && !!sessionId,
    staleTime: Infinity,
    // Retry transient failures (sandbox still warming, brief network blip) so a
    // single failed lookup doesn't settle as "not found" and flash the
    // not-accessible error. The query stays in its loading state across retries.
    retry: (failureCount, error) =>
      !isOpenCodeConfigInvalidError(error) && failureCount < 3,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10000),
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
      const opts = options || {};
      // Opencode-inside-sandbox can be still booting when this fires (auto-
      // create on session page mount). The sandbox proxy returns 503 with
      // "opencode not ready" until the binary binds its port. Retry that
      // specific transient inline — anything else propagates immediately.
      for (let attempt = 0; ; attempt++) {
        try {
          const client = getClient();
          const result = await client.session.create({
            directory: opts.directory,
            title: opts.title,
          });
          return unwrap(result);
        } catch (e) {
          const msg = (e as { message?: string })?.message ?? '';
          if (attempt < 6 && /opencode not ready/i.test(msg)) {
            await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4_000)));
            continue;
          }
          throw e;
        }
      }
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

export function useOpenCodeSessionDiff(sessionId: string) {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery({
    queryKey: ['opencode', 'session-diff', sessionId],
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.diff({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: runtimeReady && !!sessionId,
    staleTime: Infinity,
  });
}

export function useOpenCodeSessionTodo(sessionId: string) {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery({
    queryKey: ['opencode', 'session-todo', sessionId],
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.todo({ sessionID: sessionId });
      const data = unwrap(result);
      return Array.isArray(data) ? data : [];
    },
    enabled: runtimeReady && !!sessionId,
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

/**
 * Load opencode agents. Pass `directory` to get the project-scoped list
 * (globals + `<directory>/.opencode/agent/*.md`). Without it, opencode returns
 * the global set only.
 */
export function useOpenCodeAgents(options?: { directory?: string }) {
  const directory = options?.directory;
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<Agent[]>({
    queryKey: directory ? [...opencodeKeys.agents(), 'dir', directory] : opencodeKeys.agents(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.app.agents(directory ? { directory } : undefined);
      const data = unwrap(result);
      const agents: Agent[] = Array.isArray(data) ? data : Object.values(data as Record<string, Agent>);
      // Agents are defined in the project repo (.kortix/opencode/agents), so the
      // roster is stable across every session that shares a working directory.
      // Cache under a directory-scoped (or global) STABLE key — not the
      // ephemeral per-sandbox server id — so a new session's picker paints from
      // cache instead of waiting on sandbox boot + the in-box /app/agents call.
      // (Previously the directory case cached nothing at all → guaranteed pop-in.)
      setLSCache(LS_AGENTS, agents, directory ? `dir:${directory}` : CACHE_SCOPE_GLOBAL);
      return agents;
    },
    placeholderData: () =>
      getLSCache<Agent[]>(LS_AGENTS, directory ? `dir:${directory}` : CACHE_SCOPE_GLOBAL),
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

// ============================================================================
// Command Hooks
// ============================================================================

export function useOpenCodeCommands() {
  const runtimeReady = useOpenCodeRuntimeReady();
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
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
}

// ============================================================================
// Summarize Hook
// ============================================================================

export function useSummarizeOpenCodeSession() {
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
// Provider Hooks
// ============================================================================

export function useOpenCodeProviders() {
  const runtimeReady = useOpenCodeRuntimeReady();
  return useQuery<ProviderListResponse>({
    queryKey: opencodeKeys.providers(),
    queryFn: async () => {
      const client = getClient();
      const result = await client.provider.list();
      const providers = unwrap(result);
      // Models are identical across every sandbox of every project (they come
      // from the platform's opencode provider config), so cache them under the
      // stable global scope — never the ephemeral per-sandbox server id.
      setLSCache(LS_PROVIDERS, providers, CACHE_SCOPE_GLOBAL);
      return providers;
    },
    placeholderData: () => getLSCache<ProviderListResponse>(LS_PROVIDERS, CACHE_SCOPE_GLOBAL),
    enabled: runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
  });
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
