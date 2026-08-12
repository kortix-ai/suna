'use client';

/**
 * The per-session message queue, persisted across reloads and tab switches.
 *
 * The rules live in `@kortix/sdk/message-queue` as pure transitions; this store
 * is the two things the SDK deliberately does not do — hold the state per
 * session, and write it to disk.
 *
 * Why it is a store and not `useState` in `SessionChat`: the queue used to be
 * component state, so switching session tabs destroyed every queued message
 * with no notice. Nothing announced the loss because nothing knew it happened.
 *
 * ## What survives a reload, and what does not
 *
 * Text, mentions, and the agent/model/variant captured at enqueue all persist.
 * `File` objects and `blob:` URLs cannot be serialized, so an attachment comes
 * back as `{ kind: 'lost' }` — a real member of the union, so the type system
 * makes the UI acknowledge it. Dropping the files silently and sending a
 * message the user believes carries them is the one outcome worth engineering
 * against.
 *
 * `inFlightId` is deliberately **not** persisted. The lock belongs to the tab
 * that owns the in-flight send; a reload means no send is on the wire, so the
 * queue must be claimable again rather than wedged behind a lock nobody holds.
 * The tradeoff is honest: a message whose send was accepted by the server in
 * the instant before a crash can be sent again on the next load. That is
 * at-least-once for a crash, versus never-again for every crash — and the
 * queue's whole purpose is not losing what you typed.
 */

import type { AttachedFile, TrackedMention } from '@/features/session/composer/types';
import {
  claimNext as claimNextIn,
  completeInFlight,
  createSessionQueue,
  editQueued,
  enqueue as enqueueIn,
  failInFlight,
  removeQueued,
  reorderQueued,
  retryFailed,
  type QueuedMessage,
  type QueuedMessageInput,
  type SessionQueue,
} from '@kortix/sdk/message-queue';
import { create } from 'zustand';

export const QUEUE_STORAGE_KEY = 'kortix_message_queue_v3';

/**
 * An attachment on a queued message. `lost` is what a `local`/`remote` file
 * becomes after a reload — it carries no data, only the fact that there was
 * one, so the UI can say so.
 */
export type QueuedAttachment = AttachedFile | { kind: 'lost' };

export type WebQueuedMessage = QueuedMessage<QueuedAttachment, TrackedMention>;
export type WebSessionQueue = SessionQueue<QueuedAttachment, TrackedMention>;

/** How many of this message's attachments did not survive being stored. */
export function hadAttachments(message: WebQueuedMessage): number {
  return (message.files ?? []).filter((f) => f.kind === 'lost').length;
}

/**
 * What a composer hands in. Ids and timestamps are the store's job.
 *
 * **Derived from the SDK's input type, never re-declared.** This used to be a
 * hand-written duplicate of `QueuedMessageInput`'s field list, and the two drifted
 * the moment the queue grew a field: `command` (27279d2232) had to be added here
 * by hand, and every call site that built one of these by hand kept dropping it.
 * Subtracting the three fields the store mints itself is the only difference
 * this type is allowed to have.
 *
 * `files` is `QueuedAttachment[]`, not `AttachedFile[]` — the wider union comes
 * free with the parameterisation, and it is what lets Undo put back an entry
 * whose attachments a reload had already reduced to `{ kind: 'lost' }`. Filtering
 * those out on the way back in would restore an entry that quietly claims it
 * never had attachments at all. `sendQueuedMessage` drops them at dispatch, which
 * is the right place: by then the user has seen them.
 */
export type EnqueueInput = Omit<
  QueuedMessageInput<QueuedAttachment, TrackedMention>,
  'id' | 'clientMessageId' | 'createdAt'
>;

interface MessageQueueState {
  queues: Record<string, WebSessionQueue>;
  /** Whether `hydrate()` has run. Hosts wait for this before drawing a queue. */
  hydrated: boolean;

  hydrate: () => void;
  getSessionQueue: (sessionId: string) => WebSessionQueue;

  enqueue: (sessionId: string, input: EnqueueInput) => void;
  remove: (sessionId: string, id: string) => void;
  edit: (sessionId: string, id: string, text: string) => void;
  reorder: (sessionId: string, id: string, toIndex: number) => void;
  clearSession: (sessionId: string) => void;

  /** Take the head for dispatch. Returns nothing if one is already in flight. */
  claimNext: (sessionId: string) => WebQueuedMessage | undefined;
  complete: (sessionId: string) => void;
  fail: (sessionId: string, error: string) => void;
  retry: (sessionId: string, id: string) => void;
}

const EMPTY: WebSessionQueue = Object.freeze(createSessionQueue<QueuedAttachment, TrackedMention>());

/** `localStorage` is absent on the server and in tests, and can throw in
 *  private mode. Every access goes through here so no caller has to care. */
function storage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

let idCounter = 0;
function nextId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}_${uuid}` : `${prefix}_${++idCounter}_${performance.now()}`;
}

/** Strip what cannot be stored: file payloads become `lost` markers, and the
 *  in-flight claim is dropped entirely (see the header). */
function persist(queues: Record<string, WebSessionQueue>): void {
  const store = storage();
  if (!store) return;
  const serializable: Record<string, { pending: unknown[]; failed: unknown[] }> = {};
  for (const [sessionId, queue] of Object.entries(queues)) {
    if (queue.pending.length === 0 && queue.failed.length === 0) continue;
    serializable[sessionId] = {
      pending: queue.pending.map(strip),
      failed: queue.failed.map(strip),
    };
  }
  try {
    store.setItem(QUEUE_STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // A full or blocked localStorage must never break sending. The queue keeps
    // working in memory for this tab; only the reload guarantee is lost.
  }
}

function strip(message: WebQueuedMessage) {
  const { files, ...rest } = message;
  return files?.length ? { ...rest, files: files.map(() => ({ kind: 'lost' as const })) } : rest;
}

function reviveMessage(raw: unknown): WebQueuedMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const command = reviveCommand(m.command);
  // Empty text is normally a dead entry, but `/webapp` with no arguments is a
  // complete instruction whose `text` is legitimately ''. Requiring text
  // unconditionally dropped exactly those on reload.
  if (typeof m.id !== 'string' || typeof m.text !== 'string' || (!m.text && !command)) {
    return null;
  }
  return {
    ...(command ? { command } : {}),
    id: m.id,
    clientMessageId: typeof m.clientMessageId === 'string' ? m.clientMessageId : m.id,
    text: m.text,
    files: Array.isArray(m.files) ? m.files.map(() => ({ kind: 'lost' as const })) : undefined,
    mentions: Array.isArray(m.mentions) ? (m.mentions as TrackedMention[]) : undefined,
    // `null` and `undefined` are preserved separately on the way back out for
    // the same reason they are on the way in — see `enqueue`. JSON keeps
    // `null` and drops `undefined`, so a missing key correctly revives as
    // `undefined` rather than being flattened to "send nothing".
    agent: typeof m.agent === 'string' ? m.agent : m.agent === null ? null : undefined,
    model: isModel(m.model) ? m.model : m.model === null ? null : undefined,
    variant: typeof m.variant === 'string' ? m.variant : m.variant === null ? null : undefined,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
    attempts: typeof m.attempts === 'number' ? m.attempts : 0,
    ...(typeof m.lastError === 'string' ? { lastError: m.lastError } : {}),
  };
}

/**
 * Revive a persisted `command`, or `undefined`.
 *
 * Validated field by field rather than cast: this comes back from
 * localStorage, which any tab (or an older build) may have written, and a
 * malformed entry must degrade to "an ordinary queued message" instead of
 * reaching `runCommand` with a non-string name.
 */
function reviveCommand(value: unknown): WebQueuedMessage['command'] {
  if (!value || typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.name !== 'string' || !c.name) return undefined;
  const s = c.split;
  if (s && typeof s === 'object') {
    const split = s as Record<string, unknown>;
    if (typeof split.before === 'string' && typeof split.after === 'string') {
      return { name: c.name, split: { before: split.before, after: split.after } };
    }
  }
  return { name: c.name };
}

function isModel(value: unknown): value is { providerID: string; modelID: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.providerID === 'string' && typeof v.modelID === 'string';
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => {
  /** Apply an SDK transition to one session and write the result. */
  const mutate = (sessionId: string, fn: (queue: WebSessionQueue) => WebSessionQueue) => {
    set((state) => {
      const queues = { ...state.queues, [sessionId]: fn(state.queues[sessionId] ?? EMPTY) };
      persist(queues);
      return { queues };
    });
  };

  return {
    queues: {},
    hydrated: false,

    hydrate: () => {
      const store = storage();
      const queues: Record<string, WebSessionQueue> = {};
      try {
        const raw = store?.getItem(QUEUE_STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue;
            const v = value as { pending?: unknown; failed?: unknown };
            queues[sessionId] = {
              pending: (Array.isArray(v.pending) ? v.pending : [])
                .map(reviveMessage)
                .filter((m): m is WebQueuedMessage => m !== null),
              failed: (Array.isArray(v.failed) ? v.failed : [])
                .map(reviveMessage)
                .filter((m): m is WebQueuedMessage => m !== null),
              // Never restored — the lock belonged to a tab that is gone.
              inFlightId: null,
            };
          }
        }
      } catch {
        // A corrupt payload is not worth a crash on session open. Start empty.
      }
      set({ queues, hydrated: true });
    },

    getSessionQueue: (sessionId) => get().queues[sessionId] ?? EMPTY,

    enqueue: (sessionId, input) =>
      mutate(sessionId, (queue) =>
        enqueueIn(queue, {
          // Spread, not a field list. A field list here is a second place for
          // a new queue field to be silently dropped, and it has already cost
          // one: `command` reached the queue type in 27279d2232 and had to be
          // remembered here by hand.
          //
          // The spread also passes agent/model/variant through EXACTLY as
          // given — `undefined` and `null` are not interchangeable downstream.
          // `handleSend` reads `undefined` as "use whatever is selected when
          // this sends" and `null` as "send no agent / model / variant at
          // all". Coercing an uncaptured value to null strips the user's model
          // from the send, and the instant shell enqueues without any of the
          // three.
          ...input,
          // After the spread: these three are the store's to mint, and no
          // caller's value for them may win.
          id: nextId('q'),
          clientMessageId: nextId('cm'),
          createdAt: Date.now(),
        }),
      ),

    remove: (sessionId, id) => mutate(sessionId, (queue) => removeQueued(queue, id)),
    edit: (sessionId, id, text) => mutate(sessionId, (queue) => editQueued(queue, id, text)),
    reorder: (sessionId, id, toIndex) =>
      mutate(sessionId, (queue) => reorderQueued(queue, id, toIndex)),

    clearSession: (sessionId) => mutate(sessionId, () => EMPTY),

    claimNext: (sessionId) => {
      const { state, claimed } = claimNextIn(get().queues[sessionId] ?? EMPTY);
      if (!claimed) return undefined;
      // Written synchronously with the claim so a second caller in the same
      // tick sees the lock. This is the whole point of the store owning it.
      set((prev) => ({ queues: { ...prev.queues, [sessionId]: state } }));
      return claimed;
    },

    complete: (sessionId) => mutate(sessionId, completeInFlight),
    fail: (sessionId, error) => mutate(sessionId, (queue) => failInFlight(queue, error)),
    retry: (sessionId, id) => mutate(sessionId, (queue) => retryFailed(queue, id)),
  };
});
