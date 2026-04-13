'use client';

/**
 * Message queue store — modeled after OpenCode's `followup` store
 * (research/opencode/packages/app/src/pages/session.tsx, lines 540-553).
 *
 * Per-session state:
 *   - items[sessionID]:  ordered queue of QueuedMessage
 *   - paused[sessionID]: when true, the drain hook will not auto-send
 *                        (set on session abort, cleared on enqueue / send-now)
 *   - failed[sessionID]: id of an item whose drain attempt threw — that item
 *                        stays at the head but the drain skips it until the
 *                        flag is cleared (matches OpenCode's behavior)
 *
 * Agent/model/variant are captured at enqueue time (matches OpenCode's
 * FollowupDraft) so a message queued under one agent doesn't drain under
 * a different one if the user changes the active agent before it sends.
 *
 * The drain mechanism lives in `use-message-queue-drain.ts` — this store
 * intentionally has no awareness of when or how messages are sent.
 */

import { create } from 'zustand';

const QUEUE_STORAGE_KEY = 'kortix_message_queue_v2';

/** Lightweight file reference for queued messages (mirrors AttachedFile from session-chat-input) */
export type QueuedFile =
  | {
      kind: 'local';
      file: File;
      localUrl: string;
      isImage: boolean;
    }
  | {
      kind: 'remote';
      url: string;
      filename: string;
      mime: string;
      isImage: boolean;
    };

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  files?: QueuedFile[];
  timestamp: number;
  /** Agent name captured at enqueue time. Drained as-is (matches OpenCode FollowupDraft). */
  agent?: string | null;
  /** Model captured at enqueue time. */
  model?: { providerID: string; modelID: string } | null;
  /** Variant captured at enqueue time. */
  variant?: string | null;
}

type PersistedItem = Pick<
  QueuedMessage,
  'id' | 'sessionId' | 'text' | 'timestamp' | 'agent' | 'model' | 'variant'
>;

interface PersistedState {
  items: Record<string, PersistedItem[]>;
  paused: Record<string, boolean>;
}

function loadStored(): PersistedState {
  if (typeof window === 'undefined') return { items: {}, paused: {} };
  try {
    const raw = window.localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return { items: {}, paused: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedState> | null;
    if (!parsed || typeof parsed !== 'object') return { items: {}, paused: {} };
    const items: Record<string, PersistedItem[]> = {};
    for (const [sessionId, list] of Object.entries(parsed.items ?? {})) {
      if (!Array.isArray(list)) continue;
      items[sessionId] = list
        .filter(
          (m): m is PersistedItem =>
            !!m && typeof m.id === 'string' && typeof m.text === 'string',
        )
        .map((m) => ({
          id: m.id,
          sessionId: m.sessionId ?? sessionId,
          text: m.text,
          timestamp: Number(m.timestamp) || Date.now(),
          agent: m.agent ?? null,
          model: m.model ?? null,
          variant: m.variant ?? null,
        }));
    }
    const paused: Record<string, boolean> = {};
    for (const [sessionId, value] of Object.entries(parsed.paused ?? {})) {
      if (value === true) paused[sessionId] = true;
    }
    return { items, paused };
  } catch {
    return { items: {}, paused: {} };
  }
}

function persist(state: { items: Record<string, QueuedMessage[]>; paused: Record<string, boolean> }): void {
  if (typeof window === 'undefined') return;
  try {
    // Strip File / blob URL state — only metadata is persisted.
    const items: Record<string, PersistedItem[]> = {};
    for (const [sessionId, list] of Object.entries(state.items)) {
      if (!list || list.length === 0) continue;
      items[sessionId] = list.map(({ id, sessionId: sid, text, timestamp, agent, model, variant }) => ({
        id,
        sessionId: sid,
        text,
        timestamp,
        agent: agent ?? null,
        model: model ?? null,
        variant: variant ?? null,
      }));
    }
    const paused: Record<string, boolean> = {};
    for (const [sessionId, value] of Object.entries(state.paused)) {
      if (value) paused[sessionId] = true;
    }
    window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify({ items, paused }));
  } catch {
    // no-op
  }
}

export interface EnqueueOptions {
  text: string;
  files?: QueuedFile[];
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
}

interface MessageQueueState {
  /** items[sessionId] = ordered queue of messages */
  items: Record<string, QueuedMessage[]>;
  /** failed[sessionId] = id of the head item that failed to send (drain skips it) */
  failed: Record<string, string | undefined>;
  /** paused[sessionId] = drain is paused (set on abort, cleared on enqueue / send-now) */
  paused: Record<string, boolean>;

  /** Append a message to a session's queue. Clears `failed` and `paused` for that session. */
  enqueue: (sessionId: string, opts: EnqueueOptions) => QueuedMessage;

  /** Remove an item by id from a session's queue. */
  remove: (sessionId: string, messageId: string) => void;

  /** Move an item one position toward the head. */
  moveUp: (sessionId: string, messageId: string) => void;

  /** Move an item one position toward the tail. */
  moveDown: (sessionId: string, messageId: string) => void;

  /** Drop everything for a session (items + flags). */
  clearSession: (sessionId: string) => void;

  /** Pause / resume auto-drain for a session. */
  setPaused: (sessionId: string, value: boolean) => void;

  /** Mark / clear the failed-head id for a session. */
  setFailed: (sessionId: string, messageId: string | undefined) => void;
}

const stored = loadStored();

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  items: stored.items as Record<string, QueuedMessage[]>,
  failed: {},
  paused: stored.paused,

  enqueue: (sessionId, opts) => {
    const message: QueuedMessage = {
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      text: opts.text,
      files: opts.files,
      timestamp: Date.now(),
      agent: opts.agent ?? null,
      model: opts.model ?? null,
      variant: opts.variant ?? null,
    };
    set((state) => {
      const next = {
        items: {
          ...state.items,
          [sessionId]: [...(state.items[sessionId] ?? []), message],
        },
        failed: { ...state.failed, [sessionId]: undefined },
        paused: { ...state.paused, [sessionId]: false },
      };
      persist(next);
      return next;
    });
    return message;
  },

  remove: (sessionId, messageId) => {
    set((state) => {
      const list = state.items[sessionId];
      if (!list) return state;
      const filtered = list.filter((m) => m.id !== messageId);
      const items = { ...state.items };
      if (filtered.length > 0) items[sessionId] = filtered;
      else delete items[sessionId];
      // Clear failed flag if it pointed at this id.
      const failed = { ...state.failed };
      if (failed[sessionId] === messageId) failed[sessionId] = undefined;
      const next = { items, failed, paused: state.paused };
      persist(next);
      return next;
    });
  },

  moveUp: (sessionId, messageId) => {
    set((state) => {
      const list = state.items[sessionId];
      if (!list) return state;
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx <= 0) return state;
      const next = [...list];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      const nextState = {
        items: { ...state.items, [sessionId]: next },
        failed: state.failed,
        paused: state.paused,
      };
      persist(nextState);
      return nextState;
    });
  },

  moveDown: (sessionId, messageId) => {
    set((state) => {
      const list = state.items[sessionId];
      if (!list) return state;
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx === -1 || idx >= list.length - 1) return state;
      const next = [...list];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      const nextState = {
        items: { ...state.items, [sessionId]: next },
        failed: state.failed,
        paused: state.paused,
      };
      persist(nextState);
      return nextState;
    });
  },

  clearSession: (sessionId) => {
    set((state) => {
      const items = { ...state.items };
      delete items[sessionId];
      const failed = { ...state.failed };
      delete failed[sessionId];
      const paused = { ...state.paused };
      delete paused[sessionId];
      const next = { items, failed, paused };
      persist(next);
      return next;
    });
  },

  setPaused: (sessionId, value) => {
    set((state) => {
      if (Boolean(state.paused[sessionId]) === value) return state;
      const paused = { ...state.paused, [sessionId]: value };
      const next = { items: state.items, failed: state.failed, paused };
      persist(next);
      return next;
    });
  },

  setFailed: (sessionId, messageId) => {
    set((state) => {
      if (state.failed[sessionId] === messageId) return state;
      const failed = { ...state.failed, [sessionId]: messageId };
      return { items: state.items, failed, paused: state.paused };
    });
  },
}));

/** Convenience selector — head of a session's queue (or undefined). */
export function selectHead(sessionId: string) {
  return (state: MessageQueueState): QueuedMessage | undefined =>
    state.items[sessionId]?.[0];
}

/** Convenience selector — full list for a session (stable empty array fallback). */
const EMPTY: QueuedMessage[] = [];
export function selectSessionItems(sessionId: string) {
  return (state: MessageQueueState): QueuedMessage[] =>
    state.items[sessionId] ?? EMPTY;
}
