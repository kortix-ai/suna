/**
 * OpenCode Sync Store — Zustand store for session messages/parts.
 *
 * This is the SINGLE SOURCE OF TRUTH for all message data (not React Query).
 * SSE events update this store incrementally; the UI reads from it.
 *
 * Mirrors the Computer frontend's opencode-sync-store.ts pattern.
 */

import { create } from 'zustand';
import type {
  Message,
  Part,
  MessageWithParts,
  SessionStatus,
  PermissionRequest,
  QuestionRequest,
} from './types';

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface SyncState {
  /** Messages indexed by sessionId -> Message[] */
  messages: Record<string, MessageWithParts[]>;
  /** Session statuses */
  sessionStatus: Record<string, SessionStatus>;
  /** Pending permissions */
  permissions: Record<string, PermissionRequest[]>;
  /** Pending questions */
  questions: Record<string, QuestionRequest[]>;

  // ── Actions ──
  /** Hydrate a session's messages from REST response */
  hydrate: (sessionId: string, messages: MessageWithParts[]) => void;
  /** Upsert a single message (from SSE) */
  upsertMessage: (sessionId: string, msg: MessageWithParts) => void;
  /** Remove a message (from SSE) */
  removeMessage: (sessionId: string, messageId: string) => void;
  /** Upsert a part on a message (from SSE) */
  upsertPart: (messageId: string, part: Part) => void;
  /** Remove a part from a message (from SSE) */
  removePart: (messageId: string, partId: string) => void;
  /** Append a delta to a part's text field (from SSE message.part.delta) */
  appendPartDelta: (messageId: string, partId: string, sessionId: string, field: string, delta: string) => void;
  /** Set session status */
  setStatus: (sessionId: string, status: SessionStatus) => void;
  /** Add optimistic user message */
  addOptimisticMessage: (sessionId: string, msg: MessageWithParts) => void;
  /** Add permission */
  addPermission: (sessionId: string, permission: PermissionRequest) => void;
  /** Remove permission */
  removePermission: (sessionId: string, permissionId: string) => void;
  /** Add question */
  addQuestion: (sessionId: string, question: QuestionRequest) => void;
  /** Remove question */
  removeQuestion: (sessionId: string, questionId: string) => void;
  /** Get messages for a session */
  getMessages: (sessionId: string) => MessageWithParts[];
  /** Get status for a session */
  getStatus: (sessionId: string) => SessionStatus | undefined;
  /** Reset all data */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Optimistic message tracking (module-level, not in store state to avoid
// unnecessary re-renders when the set changes)
// ---------------------------------------------------------------------------

const optimisticIds = new Set<string>();

export function markOptimistic(id: string) {
  optimisticIds.add(id);
}

export function isOptimistic(id: string): boolean {
  return optimisticIds.has(id);
}

// Track part IDs that have received at least one delta.
// Used by upsertPart to avoid overwriting delta-accumulated text with a
// stale message.part.updated snapshot that arrives before deltas.
// Cleared when the streaming session goes idle.
const deltaActiveParts = new Set<string>();

export function clearDeltaActiveParts() {
  deltaActiveParts.clear();
}

// Track message IDs whose current parts are "bridged" — carried over from an
// optimistic user message during the optimistic→real swap because the server
// hadn't sent real parts yet. On the first real part update the bridge is
// cleared so we don't double-render the user's text. Mirrors web 77886a8.
const bridgedPartIds = new Set<string>();

/** Mark a message as currently carrying bridged (optimistic) parts. The next
 * real part update will clear these before inserting. Used by the SSE
 * message.updated handler when it bridges an optimistic user message's
 * parts onto the real user message ID. */
export function markBridgedParts(messageId: string) {
  bridgedPartIds.add(messageId);
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useSyncStore = create<SyncState>((set, get) => ({
  messages: {},
  sessionStatus: {},
  permissions: {},
  questions: {},

  hydrate: (sessionId, messages) =>
    set((state) => {
      const existing = state.messages[sessionId];
      if (!existing || existing.length === 0) {
        // No existing data — accept the hydration as-is
        return { messages: { ...state.messages, [sessionId]: messages } };
      }

      // Reconcile: for text/reasoning parts that are currently being
      // streamed, the SSE-accumulated version may have MORE content
      // than the REST snapshot. Prefer the longer version to avoid
      // clobbering in-progress streaming text.
      const reconciled = messages.map((incomingMsg) => {
        const existingMsg = existing.find(
          (m) => m.info.id === incomingMsg.info.id,
        );
        if (!existingMsg) return incomingMsg;

        // If this message is still carrying bridged optimistic parts and the
        // server has now delivered real parts, replace outright (the bridge
        // should never coexist with real parts). Mirrors web 77886a8.
        if (
          bridgedPartIds.has(incomingMsg.info.id) &&
          incomingMsg.parts.length > 0
        ) {
          bridgedPartIds.delete(incomingMsg.info.id);
          return incomingMsg;
        }

        const reconciledParts = incomingMsg.parts.map((inPart) => {
          const exPart = existingMsg.parts.find((p) => p.id === inPart.id);
          if (!exPart) return inPart;

          const isTextLike =
            inPart.type === 'text' || inPart.type === 'reasoning';
          if (!isTextLike) return inPart;

          const inText = (inPart as any).text;
          const exText = (exPart as any).text;
          if (
            typeof exText === 'string' &&
            typeof inText === 'string' &&
            exText.length > inText.length
          ) {
            // SSE version has more content — keep it
            return exPart;
          }
          return inPart;
        });

        return { ...incomingMsg, parts: reconciledParts };
      });

      // Bridge optimistic parts onto the real user message. When a fetch
      // races ahead of parts persistence, the server returns the real user
      // message with empty parts and `reconciled` above drops the optimistic
      // entry entirely — leaving an empty user bubble. Carry the optimistic
      // parts over under the real message ID so the text stays on screen
      // until the server's part.updated arrives. Mirrors web 77886a8.
      const realUserMsg = messages.find(
        (m) => m.info.role === 'user' && !optimisticIds.has(m.info.id),
      );
      if (realUserMsg) {
        const reconciledRealIdx = reconciled.findIndex(
          (m) => m.info.id === realUserMsg.info.id,
        );
        if (reconciledRealIdx >= 0 && reconciled[reconciledRealIdx].parts.length === 0) {
          const optimisticUserMsg = existing.find(
            (m) => m.info.role === 'user' && optimisticIds.has(m.info.id),
          );
          const bridgeParts = optimisticUserMsg?.parts ?? [];
          if (bridgeParts.length > 0) {
            reconciled[reconciledRealIdx] = {
              ...reconciled[reconciledRealIdx],
              parts: bridgeParts,
            };
            bridgedPartIds.add(realUserMsg.info.id);
          }
        }
      }

      return { messages: { ...state.messages, [sessionId]: reconciled } };
    }),

  upsertMessage: (sessionId, msg) =>
    set((state) => {
      const existing = state.messages[sessionId] || [];
      const idx = existing.findIndex((m) => m.info.id === msg.info.id);
      const updated =
        idx >= 0
          ? existing.map((m, i) => (i === idx ? msg : m))
          : [...existing, msg];
      return { messages: { ...state.messages, [sessionId]: updated } };
    }),

  removeMessage: (sessionId, messageId) =>
    set((state) => {
      const existing = state.messages[sessionId] || [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: existing.filter((m) => m.info.id !== messageId),
        },
      };
    }),

  upsertPart: (messageId, part) =>
    set((state) => {
      const newMessages = { ...state.messages };
      // If this message had bridged (optimistic) parts carried over by
      // hydrate, clear them now that a real part has arrived so we don't
      // double-render. Mirrors web 77886a8.
      const bridgeCleared = bridgedPartIds.has(messageId);
      if (bridgeCleared) bridgedPartIds.delete(messageId);
      for (const sessionId of Object.keys(newMessages)) {
        const msgs = newMessages[sessionId];
        const msgIdx = msgs.findIndex((m) => m.info.id === messageId);
        if (msgIdx >= 0) {
          const msg = bridgeCleared
            ? { ...msgs[msgIdx], parts: [] as Part[] }
            : msgs[msgIdx];
          const partIdx = msg.parts.findIndex((p) => p.id === part.id);
          let updatedParts: Part[];
          if (partIdx >= 0) {
            const prev = msg.parts[partIdx] as any;
            const incoming = part as any;

            // Guard against out-of-order/stale part snapshots that can
            // cause the stream to jump or start from the middle.
            // For text/reasoning parts, only accept full-text replacements
            // that are monotonic prefix growth (incoming starts with
            // previous text). Otherwise keep the existing part.
            const tracksStreamingText =
              (prev?.type === 'text' || prev?.type === 'reasoning') &&
              (incoming?.type === 'text' || incoming?.type === 'reasoning');
            const prevText = typeof prev?.text === 'string' ? prev.text : null;
            const incomingText =
              typeof incoming?.text === 'string' ? incoming.text : null;

            if (
              tracksStreamingText &&
              prevText !== null &&
              incomingText !== null &&
              prevText.length > 0
            ) {
              const isPrefixGrowth = incomingText.startsWith(prevText);
              if (!isPrefixGrowth) {
                // Stale/out-of-order snapshot — reject the update
                return state;
              }
            }

            updatedParts = msg.parts.map((p, i) => (i === partIdx ? part : p));
          } else {
            // For NEW text/reasoning parts: if deltas have already been
            // applied for this part ID, the part was created by the delta
            // handler with correct accumulated text. A stale snapshot
            // arriving later would overwrite it with wrong text.
            const incoming = part as any;
            if (
              deltaActiveParts.has(part.id) &&
              (incoming?.type === 'text' || incoming?.type === 'reasoning')
            ) {
              // Check if the delta-created part already exists in any message
              for (const sid of Object.keys(state.messages)) {
                const sessionMsgs = state.messages[sid];
                for (const m of sessionMsgs) {
                  if (m.parts.some((p) => p.id === part.id)) {
                    return state;
                  }
                }
              }
            }

            // When a real part arrives, remove any optimistic fallback parts
            // of the same type to prevent duplicates (e.g. double user text)
            const baseParts = msg.parts.filter(
              (p) => !(p.type === part.type && p.id.startsWith('prt_')),
            );
            updatedParts = [...baseParts, part];
          }
          const updatedMsg = { ...msg, parts: updatedParts };
          newMessages[sessionId] = msgs.map((m, i) =>
            i === msgIdx ? updatedMsg : m,
          );
          break;
        }
      }
      return { messages: newMessages };
    }),

  removePart: (messageId, partId) =>
    set((state) => {
      const newMessages = { ...state.messages };
      for (const sessionId of Object.keys(newMessages)) {
        const msgs = newMessages[sessionId];
        const msgIdx = msgs.findIndex((m) => m.info.id === messageId);
        if (msgIdx >= 0) {
          const msg = msgs[msgIdx];
          const updatedMsg = {
            ...msg,
            parts: msg.parts.filter((p) => p.id !== partId),
          };
          newMessages[sessionId] = msgs.map((m, i) =>
            i === msgIdx ? updatedMsg : m,
          );
          break;
        }
      }
      return { messages: newMessages };
    }),

  appendPartDelta: (messageId, partId, sessionId, field, delta) => {
    deltaActiveParts.add(partId);
    return set((state) => {
      const msgs = state.messages[sessionId];
      if (!msgs) return state;

      const msgIdx = msgs.findIndex((m) => m.info.id === messageId);
      if (msgIdx < 0) return state;

      const msg = msgs[msgIdx];
      const partIdx = msg.parts.findIndex((p) => p.id === partId);

      let updatedParts: Part[];
      if (partIdx < 0) {
        // Part doesn't exist — create a stub starting from an EMPTY string,
        // then append the delta. Initializing with `delta` (the old behavior)
        // caused streamed text to appear mid-word: later full-text snapshots
        // were rejected by upsertPart's prefix-growth guard because they
        // didn't start with the partial delta. Starting from "" matches web's
        // applyPartDelta semantics (apps/web/src/stores/opencode-sync-store.ts).
        // Callers (event handlers) should still pre-create an empty stub to
        // avoid relying on this fallback, but this keeps delta data intact
        // even when they don't.
        const stub: Part = { type: field === 'reasoning' ? 'reasoning' : 'text', id: partId, [field]: delta } as any;
        updatedParts = [...msg.parts, stub];
      } else {
        updatedParts = msg.parts.map((p, i) => {
          if (i !== partIdx) return p;
          return { ...p, [field]: ((p as any)[field] || '') + delta };
        });
      }

      const updatedMsg = { ...msg, parts: updatedParts };
      const newMsgs = msgs.map((m, i) => (i === msgIdx ? updatedMsg : m));

      return {
        messages: { ...state.messages, [sessionId]: newMsgs },
      };
    });
  },

  setStatus: (sessionId, status) =>
    set((state) => ({
      sessionStatus: { ...state.sessionStatus, [sessionId]: status },
    })),

  addOptimisticMessage: (sessionId, msg) => {
    optimisticIds.add(msg.info.id);
    set((state) => {
      const existing = state.messages[sessionId] || [];
      return {
        messages: { ...state.messages, [sessionId]: [...existing, msg] },
      };
    });
  },

  addPermission: (sessionId, permission) =>
    set((state) => ({
      permissions: {
        ...state.permissions,
        [sessionId]: [...(state.permissions[sessionId] || []), permission],
      },
    })),

  removePermission: (sessionId, permissionId) =>
    set((state) => ({
      permissions: {
        ...state.permissions,
        [sessionId]: (state.permissions[sessionId] || []).filter(
          (p) => p.id !== permissionId,
        ),
      },
    })),

  addQuestion: (sessionId, question) =>
    set((state) => ({
      questions: {
        ...state.questions,
        [sessionId]: [...(state.questions[sessionId] || []), question],
      },
    })),

  removeQuestion: (sessionId, questionId) =>
    set((state) => ({
      questions: {
        ...state.questions,
        [sessionId]: (state.questions[sessionId] || []).filter(
          (q) => q.id !== questionId,
        ),
      },
    })),

  getMessages: (sessionId) => get().messages[sessionId] || [],

  getStatus: (sessionId) => get().sessionStatus[sessionId],

  reset: () => {
    bridgedPartIds.clear();
    set({ messages: {}, sessionStatus: {}, permissions: {}, questions: {} });
  },
}));
