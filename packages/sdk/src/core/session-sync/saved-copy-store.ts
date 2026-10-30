/**
 * The last saved copies of a user's sessions, kept on the device.
 *
 * Opening a session painted nothing until the control plane answered with the
 * saved copy it captured at the last turn end: skeleton rows for 0.3-2.3 s on
 * every cold open, and for as long as the backend took when it was slow. With
 * this store the next open paints the last copy as soon as the device reads it
 * (one task after the first frame), and the fresh one reconciles into it by
 * message id.
 *
 * WHAT IT STORES, AND WHY THAT IS SAFE. Only envelopes the SERVER sent: the
 * transcript mirror, which the API writes because a turn ended, carrying
 * OpenCode's `info` verbatim (`time.completed` and `error` included) and the
 * OpenCode root it was captured from. It never stores the live transcript. An
 * IndexedDB mirror of the live store was deleted (`5a7a43517f`) because its
 * write test read the transcript's shape, missed a Stop, and painted a stopped
 * turn as running. A server capture has no client-side freshness test to get
 * wrong, and the painting side keeps its root-identity guard
 * (`shouldHydrateFromMirror`).
 *
 * Framework-free: the host passes the storage (IndexedDB on web, through
 * `indexedDBKeyValueStorage`; AsyncStorage on mobile) and the signed-in user.
 * Both are asynchronous, so no read blocks a frame. Every failure — a full,
 * corrupt or missing store — costs only the old cold open; nothing throws.
 */

import type { KeyValueStorage } from '../cache/persisted-query-cache';
import type { SessionTranscriptSyncEnvelope } from '../rest/projects-client/sessions';
import { registerSessionLogCopies, SESSION_LOG_COPY } from '../session-log/saved-log';
import type { CopyCodec, CopyStore, StoredCopy } from './copy-store-types';
import { VERSION, createSavedCopyIndex, isPromise, then, type IndexEntry } from './saved-copy-index';

export interface SavedCopyStoreOptions {
  storage: KeyValueStorage;
  /** The signed-in user. Only this user's copies are read or written. */
  userId: string;
  /** How many sessions to keep. Default: 12. */
  maxSessions?: number;
  /** Upper bound of all copies together, in UTF-16 code units. Default: 1,500,000. */
  maxBytes?: number;
  /**
   * Upper bound of one session's copy, in UTF-16 code units. A larger copy
   * keeps its newest messages that fit and pages the rest from the server;
   * one whose newest message alone does not fit is not kept. Default: 300,000.
   */
  maxEnvelopeBytes?: number;
  /** A copy older than this is not painted. Default: 14 days. */
  maxAgeMs?: number;
  /** Storage key prefix. Default: `kortix.saved-copy`. */
  namespace?: string;
  now?: () => number;
}

export interface SavedCopyStore {
  /** The storage key of one session's copy. */
  keyFor(projectId: string, sessionId: string): string;
  /** The last saved copy, synchronously when the storage is synchronous. */
  read(
    projectId: string,
    sessionId: string,
  ): SessionTranscriptSyncEnvelope | null | Promise<SessionTranscriptSyncEnvelope | null>;
  /**
   * Keep `envelope` as this session's copy. An envelope that cannot be painted
   * (unavailable, empty, rootless) removes the copy instead: the server no
   * longer vouches for one. An older capture never replaces a newer one.
   */
  write(projectId: string, sessionId: string, envelope: SessionTranscriptSyncEnvelope): Promise<void>;
  remove(projectId: string, sessionId: string): Promise<void>;
  /** Forget every copy of this user. */
  clear(): Promise<void>;
}

/** A copy worth painting: a non-empty mirror window that names its OpenCode root. */
export function isPaintableSavedCopy(
  envelope: SessionTranscriptSyncEnvelope | null | undefined,
): envelope is SessionTranscriptSyncEnvelope {
  return (
    !!envelope &&
    envelope.available === true &&
    envelope.source === 'mirror' &&
    Array.isArray(envelope.messages) &&
    envelope.messages.length > 0 &&
    // A copy saved by an SDK before W4 names the root only `opencode_session_id`.
    !!(envelope.runtime_session_id ?? envelope.opencode_session_id)
  );
}

const DEFAULT_MAX_SESSIONS = 12;
const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_MAX_ENVELOPE_BYTES = 300_000;
const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_NAMESPACE = 'kortix.saved-copy';

/**
 * The serialized copy to keep within `maxChars`: the whole copy when it fits,
 * else its NEWEST messages that fit, with the cursor moved to the oldest one
 * kept (the server serves the window strictly older than the cursor). Null
 * when not even the newest message fits.
 *
 * Copies carry every tool call 1:1, so a 40-message window of a tool-heavy
 * thread outgrows the bound. The newest messages are what the first frame
 * shows; refusing the whole copy gave exactly those sessions a cold open.
 */
function fitSavedCopy(stored: StoredCopy<SessionTranscriptSyncEnvelope>, maxChars: number): string | null {
  const whole = JSON.stringify(stored);
  if (whole.length <= maxChars) return whole;
  const { messages } = stored.e;
  if (messages.length === 0) return null;
  const trimmed = (keep: number): string => {
    const kept = messages.slice(messages.length - keep);
    return JSON.stringify({
      ...stored,
      e: {
        ...stored.e,
        messages: kept,
        message_count: kept.length,
        complete: false,
        next_cursor: String(kept[0].info.id),
      },
    });
  };
  // Count what fits from the newest message back, then confirm on the real
  // text: the cursor and count fields change length with the cut.
  let size = trimmed(1).length - JSON.stringify(messages[messages.length - 1]).length;
  let keep = 0;
  while (keep < messages.length) {
    const next = JSON.stringify(messages[messages.length - 1 - keep]).length + (keep > 0 ? 1 : 0);
    if (size + next > maxChars) break;
    size += next;
    keep += 1;
  }
  for (; keep > 0; keep -= 1) {
    const text = trimmed(keep);
    if (text.length <= maxChars) return text;
  }
  return null;
}

function capturedAtMs(envelope: SessionTranscriptSyncEnvelope): number {
  const parsed = envelope.captured_at ? Date.parse(envelope.captured_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

const ENVELOPE: CopyCodec<SessionTranscriptSyncEnvelope> = {
  paintable: isPaintableSavedCopy,
  fit: fitSavedCopy,
  capturedAt: capturedAtMs,
};

/**
 * The v1 store. A second store under `<namespace>.log` keeps the v2 copies (the session-log
 * page, `core/session-log/saved-log.ts`): a separate key, so a copy one format wrote is never
 * read as the other. `remove` and `clear` forget both.
 */
export function createSavedCopyStore(options: SavedCopyStoreOptions): SavedCopyStore {
  const v1 = createCopyStore(options, ENVELOPE);
  const v2 = createCopyStore({ ...options, namespace: `${options.namespace ?? DEFAULT_NAMESPACE}.log` }, SESSION_LOG_COPY);
  const store: SavedCopyStore = {
    ...v1,
    remove: async (projectId, sessionId) => {
      await Promise.all([v1.remove(projectId, sessionId), v2.remove(projectId, sessionId)]);
    },
    clear: async () => {
      await Promise.all([v1.clear(), v2.clear()]);
    },
  };
  registerSessionLogCopies(store, v2, v1.remove);
  return store;
}

function createCopyStore<T>(options: SavedCopyStoreOptions, codec: CopyCodec<T>): CopyStore<T> {
  const {
    storage,
    userId,
    maxSessions = DEFAULT_MAX_SESSIONS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxEnvelopeBytes = DEFAULT_MAX_ENVELOPE_BYTES,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    namespace = DEFAULT_NAMESPACE,
    now = () => Date.now(),
  } = options;
  const prefix = `${namespace}:${userId}:`;
  const index = createSavedCopyIndex({ storage, prefix, maxSessions, maxBytes, now });
  const { indexKey, safeGet, safeRemove, enqueue, loadIndex, saveIndex, evict, touch, forgetScope } =
    index;
  const keyFor = (projectId: string, sessionId: string) => `${prefix}${projectId}/${sessionId}`;

  /** Starts the removal now, so a synchronous store has forgotten the key on return. */
  const removeNow = (key: string): void => {
    try {
      const removal = storage.removeItem(key);
      if (isPromise<void>(removal)) removal.catch(() => undefined);
    } catch {
      // Nothing to forget.
    }
  };

  return {
    keyFor,

    read(projectId, sessionId) {
      const scope = `${projectId}/${sessionId}`;
      return then(safeGet(keyFor(projectId, sessionId)), (raw) => {
        if (!raw) return null;
        let stored: StoredCopy<T>;
        try {
          stored = JSON.parse(raw) as StoredCopy<T>;
        } catch {
          removeNow(keyFor(projectId, sessionId));
          void forgetScope(scope);
          return null;
        }
        if (
          !stored ||
          stored.v !== VERSION ||
          stored.user !== userId ||
          now() - stored.at > maxAgeMs ||
          !codec.paintable(stored.e)
        ) {
          removeNow(keyFor(projectId, sessionId));
          void forgetScope(scope);
          return null;
        }
        touch(scope);
        return stored.e;
      });
    },

    write(projectId, sessionId, envelope) {
      const scope = `${projectId}/${sessionId}`;
      if (!codec.paintable(envelope)) return forgetScope(scope);
      const stored: StoredCopy<T> = { v: VERSION, user: userId, at: now(), e: envelope };
      const text = codec.fit(stored, maxEnvelopeBytes);
      if (text === null) return forgetScope(scope);
      const captured = codec.capturedAt(envelope);
      return enqueue(async () => {
        const entries = await loadIndex();
        const existing = entries.find((entry) => entry.s === scope);
        if (existing && captured > 0 && existing.c > captured) return;
        const others = entries.filter((entry) => entry.s !== scope);
        const entry: IndexEntry = { s: scope, b: text.length, u: now(), c: captured };
        let kept = await evict([...others, entry], scope);
        const key = keyFor(projectId, sessionId);
        try {
          await storage.setItem(key, text);
        } catch {
          // Full: free the least recent copy and try once more.
          const oldest = kept.filter((candidate) => candidate.s !== scope).sort((a, b) => a.u - b.u)[0];
          if (oldest) {
            await safeRemove(`${prefix}${oldest.s}`);
            kept = kept.filter((candidate) => candidate.s !== oldest.s);
          }
          try {
            await storage.setItem(key, text);
          } catch {
            await safeRemove(key);
            kept = kept.filter((candidate) => candidate.s !== scope);
          }
        }
        await saveIndex(kept);
      });
    },

    remove(projectId, sessionId) {
      return forgetScope(`${projectId}/${sessionId}`);
    },

    clear() {
      return enqueue(async () => {
        const entries = await loadIndex();
        for (const entry of entries) await safeRemove(`${prefix}${entry.s}`);
        await safeRemove(indexKey);
      });
    },
  };
}

let currentStore: SavedCopyStore | null = null;

/**
 * The store the session transcript paints from and writes to. The host sets it
 * when a user signs in and sets `null` on sign-out (after `clear()`), because
 * only the host knows who is signed in. With no store, opening a session
 * behaves exactly as before: nothing is read or written on the device.
 */
export function setSavedCopyStore(store: SavedCopyStore | null): void {
  currentStore = store;
}

export function currentSavedCopyStore(): SavedCopyStore | null {
  return currentStore;
}
