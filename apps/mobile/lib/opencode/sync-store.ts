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
  /**
   * Hydrate a session's messages from a REST response. `source: 'cache'` marks
   * a saved copy: its messages stay provisional until a runtime read settles
   * them (see `settleCacheSourced`).
   */
  hydrate: (sessionId: string, messages: MessageWithParts[], options?: { source?: 'cache' }) => void;
  /** Upsert a single message (from SSE) */
  upsertMessage: (sessionId: string, msg: MessageWithParts) => void;
  /** Remove a message (from SSE) */
  removeMessage: (sessionId: string, messageId: string) => void;
  /** Upsert a part on a message (from SSE). With `sessionId`, only that
   *  session is searched; without it, every loaded session is. */
  upsertPart: (messageId: string, part: Part, sessionId?: string) => void;
  /** Remove a part from a message (from SSE). `sessionId` scopes the search. */
  removePart: (messageId: string, partId: string, sessionId?: string) => void;
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
  /** Drop every piece of state held for these sessions */
  evictSessions: (sessionIds: readonly string[]) => void;
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

/**
 * Message ids painted from a SAVED COPY (the server's capture from the last
 * turn end) that no runtime read has confirmed yet, per session. The copy
 * shows the thread while the computer wakes; the first runtime read then
 * decides which of these still exist. Web has the same rule
 * (`@kortix/sdk` sync store, `cacheSourcedIds`).
 */
const cacheSourcedIds = new Map<string, Set<string>>();

/**
 * Does this session hold messages, every one of them from a saved copy? Only
 * then may a newer saved copy paint over it: once the runtime has answered, a
 * snapshot is older than what the store holds.
 */
export function hasOnlyCacheSourcedMessages(sessionId: string): boolean {
  const messages = useSyncStore.getState().messages[sessionId];
  const cached = cacheSourcedIds.get(sessionId);
  if (!messages || messages.length === 0 || !cached) return false;
  return messages.every((message) => cached.has(message.info.id));
}

/**
 * A runtime read settles the saved copy's provisional messages: the ones it
 * contains are real; the ones it lacks but whose time it COVERS (at or after
 * the oldest message it returned) no longer exist there — a rewind removed
 * them — and are dropped. Older ones are history the bounded tail did not
 * reach: kept, still provisional. An empty read covers everything.
 */
function settleCacheSourced(
  sessionId: string,
  existing: MessageWithParts[] | undefined,
  incoming: MessageWithParts[],
): MessageWithParts[] | undefined {
  const cached = cacheSourcedIds.get(sessionId);
  if (!cached || cached.size === 0 || !existing) return existing;
  const incomingIds = new Set(incoming.map((message) => message.info.id));
  let oldest = Number.POSITIVE_INFINITY;
  for (const message of incoming) oldest = Math.min(oldest, message.info.time?.created ?? oldest);
  const dropped = new Set<string>();
  for (const message of existing) {
    const id = message.info.id;
    if (!cached.has(id)) continue;
    if (incomingIds.has(id)) {
      cached.delete(id);
      continue;
    }
    const created = message.info.time?.created ?? Number.POSITIVE_INFINITY;
    if (incoming.length === 0 || created >= oldest) {
      cached.delete(id);
      dropped.add(id);
    }
  }
  if (cached.size === 0) cacheSourcedIds.delete(sessionId);
  return dropped.size === 0 ? existing : existing.filter((message) => !dropped.has(message.info.id));
}

/**
 * Part ids an optimistic message carried (COR-185). A real part drops only
 * these: real OpenCode part ids also start with `prt_`, so a prefix check
 * let a message's second real file part remove its first.
 */
const optimisticPartIds = new Set<string>();
/** Each optimistic message's part ids, so forgetting the message forgets them too. */
const optimisticPartIdsByMessage = new Map<string, string[]>();

export function isOptimisticPart(id: string): boolean {
  return optimisticPartIds.has(id);
}

/** Forget one optimistic message: its id and the part ids it carried. */
function forgetOptimistic(messageId: string) {
  optimisticIds.delete(messageId);
  for (const partId of optimisticPartIdsByMessage.get(messageId) ?? []) {
    optimisticPartIds.delete(partId);
  }
  optimisticPartIdsByMessage.delete(messageId);
}

/**
 * Forget optimistic ids whose messages a real message has replaced, with
 * their part ids. A bridged message (the real id carrying the optimistic
 * parts) does not need them: `bridgedPartIds` clears its parts outright.
 */
export function clearOptimistic(ids: Iterable<string>) {
  for (const id of ids) forgetOptimistic(id);
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

/**
 * Where `message` belongs in a transcript already ordered by `time.created` —
 * the first position whose message is strictly newer, or the end.
 *
 * `time.created` with the id as the ONLY tie-break: the same order the
 * server's `MessageV2.latest()` uses, and the key `MessageV2.page()` pages by.
 * Never an id-first comparison — ids stopped ascending with time in OpenCode
 * 1.18.15. A message with no readable `time` cannot be dated and goes last,
 * which is where the newest thing we know about belongs.
 */
function insertIndexByTime(
  list: readonly MessageWithParts[],
  message: MessageWithParts,
): number {
  const created = message.info.time?.created;
  if (created === undefined) return list.length;
  for (let index = 0; index < list.length; index++) {
    const other = list[index].info.time?.created;
    if (other === undefined) continue;
    if (other > created) return index;
    if (other === created && list[index].info.id > message.info.id) return index;
  }
  return list.length;
}

/** Nesting depth past which `sameValue` stops and reports "different". */
const MAX_COMPARE_DEPTH = 8;

/**
 * Structural equality for JSON-shaped wire data. Used by `hydrate` to keep the
 * existing object when a re-read returns the same content, so memoized rows do
 * not re-render on every tail verification. Beyond `MAX_COMPARE_DEPTH` it
 * answers "different", which only costs a re-render.
 */
function sameValue(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (depth >= MAX_COMPARE_DEPTH) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!sameValue(a[index], b[index], depth + 1)) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!sameValue(left[key], right[key], depth + 1)) return false;
  }
  return true;
}

/**
 * The part to keep for one incoming REST part. Text and reasoning keep the
 * longer SSE-accumulated text while it streams; any part whose content did not
 * change keeps the existing object.
 */
function reconcilePart(inPart: Part, exPart: Part | undefined): Part {
  if (!exPart) return inPart;
  if (inPart.type === 'text' || inPart.type === 'reasoning') {
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
  }
  return sameValue(inPart, exPart) ? exPart : inPart;
}

function isWorking(status: SessionStatus | undefined): boolean {
  return status?.type === 'busy' || status?.type === 'retry';
}

/**
 * Sessions whose state may be dropped: every session the store holds data
 * for, except those in `keep`, those still working, and those carrying an
 * optimistic message (a send in flight before its page mounts).
 */
export function selectSessionsToEvict(
  state: Pick<SyncState, 'messages' | 'sessionStatus' | 'questions' | 'permissions'>,
  keep: ReadonlySet<string>,
): string[] {
  const loaded = new Set([
    ...Object.keys(state.messages),
    ...Object.keys(state.sessionStatus),
    ...Object.keys(state.questions),
    ...Object.keys(state.permissions),
  ]);
  const evict: string[] = [];
  for (const sessionId of loaded) {
    if (keep.has(sessionId) || isWorking(state.sessionStatus[sessionId])) continue;
    const messages = state.messages[sessionId];
    if (messages?.some((message) => optimisticIds.has(message.info.id))) continue;
    evict.push(sessionId);
  }
  return evict;
}

function omitKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  if (!keys.some((key) => key in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useSyncStore = create<SyncState>((set, get) => ({
  messages: {},
  sessionStatus: {},
  permissions: {},
  questions: {},

  hydrate: (sessionId, messages, options) =>
    set((state) => {
      let existing: MessageWithParts[] | undefined = state.messages[sessionId];
      if (options?.source === 'cache') {
        let cached = cacheSourcedIds.get(sessionId);
        if (!cached) cacheSourcedIds.set(sessionId, (cached = new Set()));
        for (const message of messages) cached.add(message.info.id);
      } else {
        existing = settleCacheSourced(sessionId, existing, messages);
      }
      if (!existing || existing.length === 0) {
        // No existing data — accept the hydration as-is
        return { messages: { ...state.messages, [sessionId]: messages } };
      }

      const incomingHasRealUserMessage = messages.some(
        (message) => message.info.role === 'user' && !optimisticIds.has(message.info.id),
      );
      const existingById = new Map(existing.map((message) => [message.info.id, message]));
      const knownIds = new Set(messages.map((message) => message.info.id));
      const supersededOptimisticIds: string[] = [];
      // The incoming page IS the order — `MessageV2.page()` orders by
      // `time_created` server-side, and always has. This used to re-sort the
      // union by `info.id.localeCompare(...)`: ids do not ascend with time
      // (OpenCode 1.18.15 retired that invariant), and `localeCompare` is not
      // byte order, so mobile and web produced DIFFERENT transcripts from
      // identical data. Locally-known messages the page lacks are placed by
      // `time.created`, the same key the server ordered by; one that cannot be
      // dated goes last, where the newest message belongs.
      const mergedMessages = [...messages];
      for (const message of existing) {
        const isSupersededOptimisticUser =
          incomingHasRealUserMessage &&
          message.info.role === 'user' &&
          optimisticIds.has(message.info.id);
        if (isSupersededOptimisticUser) supersededOptimisticIds.push(message.info.id);
        if (knownIds.has(message.info.id) || isSupersededOptimisticUser) continue;
        knownIds.add(message.info.id);
        mergedMessages.splice(insertIndexByTime(mergedMessages, message), 0, message);
      }

      // Reconcile against what the store already holds. For text/reasoning
      // parts that are currently being streamed, the SSE-accumulated version
      // may have MORE content than the REST snapshot: prefer the longer one
      // to avoid clobbering in-progress streaming text. Everything whose
      // content did not change keeps its existing object, so a re-read of the
      // same tail does not re-render the transcript.
      const reconciled = mergedMessages.map((incomingMsg) => {
        const existingMsg = existingById.get(incomingMsg.info.id);
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
        if (incomingMsg === existingMsg) return existingMsg;

        const existingParts = existingMsg.parts;
        let existingPartsById: Map<string, Part> | undefined;
        let partsReused = incomingMsg.parts.length === existingParts.length;
        const reconciledParts = incomingMsg.parts.map((inPart, index) => {
          let exPart: Part | undefined = existingParts[index];
          if (exPart?.id !== inPart.id) {
            existingPartsById ??= new Map(existingParts.map((part) => [part.id, part]));
            exPart = existingPartsById.get(inPart.id);
          }
          const part = reconcilePart(inPart, exPart);
          if (part !== existingParts[index]) partsReused = false;
          return part;
        });

        if (partsReused && sameValue(incomingMsg.info, existingMsg.info)) return existingMsg;
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

      // The real user message replaced these; their ids are no longer needed.
      clearOptimistic(supersededOptimisticIds);

      const unchanged =
        reconciled.length === existing.length &&
        reconciled.every((message, index) => message === existing[index]);
      if (unchanged) return state;
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
      forgetOptimistic(messageId);
      const existing = state.messages[sessionId] || [];
      return {
        messages: {
          ...state.messages,
          [sessionId]: existing.filter((m) => m.info.id !== messageId),
        },
      };
    }),

  upsertPart: (messageId, part, scopeSessionId) =>
    set((state) => {
      // If this message had bridged (optimistic) parts carried over by
      // hydrate, clear them now that a real part has arrived so we don't
      // double-render. Mirrors web 77886a8.
      const bridgeCleared = bridgedPartIds.has(messageId);
      if (bridgeCleared) bridgedPartIds.delete(messageId);
      // The event carries its session; scanning every loaded session is only
      // the fallback for callers that do not know it.
      const sessionIds =
        scopeSessionId !== undefined ? [scopeSessionId] : Object.keys(state.messages);
      for (const sessionId of sessionIds) {
        const msgs = state.messages[sessionId];
        if (!msgs) continue;
        const msgIdx = msgs.findIndex((m) => m.info.id === messageId);
        if (msgIdx < 0) continue;
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
            // of the searched sessions.
            for (const sid of sessionIds) {
              const sessionMsgs = state.messages[sid];
              if (!sessionMsgs) continue;
              for (const m of sessionMsgs) {
                if (m.parts.some((p) => p.id === part.id)) {
                  return state;
                }
              }
            }
          }

          // When a real part arrives, remove the optimistic fallback parts
          // of the same type to prevent duplicates (e.g. double user text).
          // Only ids an optimistic message carried: real ids share `prt_`.
          const baseParts = msg.parts.filter((p) => {
            if (p.type !== part.type || !optimisticPartIds.has(p.id)) return true;
            optimisticPartIds.delete(p.id);
            return false;
          });
          updatedParts = [...baseParts, part];
        }
        const updatedMsg = { ...msg, parts: updatedParts };
        return {
          messages: {
            ...state.messages,
            [sessionId]: msgs.map((m, i) => (i === msgIdx ? updatedMsg : m)),
          },
        };
      }
      return state;
    }),

  removePart: (messageId, partId, scopeSessionId) =>
    set((state) => {
      const sessionIds =
        scopeSessionId !== undefined ? [scopeSessionId] : Object.keys(state.messages);
      for (const sessionId of sessionIds) {
        const msgs = state.messages[sessionId];
        if (!msgs) continue;
        const msgIdx = msgs.findIndex((m) => m.info.id === messageId);
        if (msgIdx < 0) continue;
        const msg = msgs[msgIdx];
        if (!msg.parts.some((p) => p.id === partId)) return state;
        const updatedMsg = {
          ...msg,
          parts: msg.parts.filter((p) => p.id !== partId),
        };
        return {
          messages: {
            ...state.messages,
            [sessionId]: msgs.map((m, i) => (i === msgIdx ? updatedMsg : m)),
          },
        };
      }
      return state;
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
    for (const part of msg.parts) optimisticPartIds.add(part.id);
    optimisticPartIdsByMessage.set(
      msg.info.id,
      msg.parts.map((part) => part.id),
    );
    set((state) => {
      const existing = state.messages[sessionId] || [];
      return {
        messages: { ...state.messages, [sessionId]: [...existing, msg] },
      };
    });
  },

  addPermission: (sessionId, permission) =>
    set((state) => {
      const existing = state.permissions[sessionId] || [];
      // Skip a permission whose id is already pending for this session — a
      // duplicate SSE delivery must not double the prompt card.
      if (existing.some((p) => p.id === permission.id)) return state;
      return {
        permissions: {
          ...state.permissions,
          [sessionId]: [...existing, permission],
        },
      };
    }),

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

  evictSessions: (sessionIds) =>
    set((state) => {
      if (sessionIds.length === 0) return state;
      for (const sessionId of sessionIds) {
        cacheSourcedIds.delete(sessionId);
        for (const message of state.messages[sessionId] ?? []) {
          bridgedPartIds.delete(message.info.id);
          forgetOptimistic(message.info.id);
          for (const part of message.parts) deltaActiveParts.delete(part.id);
        }
      }
      const messages = omitKeys(state.messages, sessionIds);
      const sessionStatus = omitKeys(state.sessionStatus, sessionIds);
      const permissions = omitKeys(state.permissions, sessionIds);
      const questions = omitKeys(state.questions, sessionIds);
      if (
        messages === state.messages &&
        sessionStatus === state.sessionStatus &&
        permissions === state.permissions &&
        questions === state.questions
      ) {
        return state;
      }
      return { messages, sessionStatus, permissions, questions };
    }),

  reset: () => {
    bridgedPartIds.clear();
    cacheSourcedIds.clear();
    optimisticPartIds.clear();
    optimisticPartIdsByMessage.clear();
    set({ messages: {}, sessionStatus: {}, permissions: {}, questions: {} });
  },
}));
