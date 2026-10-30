/**
 * The client store of one session's log (`kortix.session/2`): a pure reducer over the
 * pages the API serves and the `log.*` frames of the runtime stream. Framework-free;
 * `browser/stores/sync-store.ts` keeps one state per session, and every function here
 * returns the SAME state object when nothing changed, so a store subscriber sees no change.
 *
 * Shape. Threads by `thread_id`, without their messages. Messages by thread, ascending
 * `seq` (the record's order; ids are opaque, so they never order anything). Blocks stay
 * in their message, in record order (the order the model saw them), and are addressed by
 * block id (F1). `revs` keeps the highest `rev` seen per message id, tombstones included.
 *
 * Merge rules (`events.ts` and `wire.ts` in api-contract):
 *  - `log.message` put `{ rev, message }`: applied when `rev` is above the one held.
 *  - `log.message` tombstone `{ message_id, rev }`: the message leaves; its rev stays, so
 *    an older put cannot revive it.
 *  - `log.block.delta`: text appended to a text or reasoning block, until the next put of
 *    that message replaces the whole record. A delta for a message or block the store does
 *    not hold is dropped, with no placeholder: kortixd (P4.3b) puts a streaming record before
 *    the first delta of a message.
 *  - `log.thread`: the thread head replaces the one held.
 *  - `log.state`: an older `generation` (a zombie box) is ignored; the session fields merge.
 *  - A page carries no revs: a page message never replaces a message the stream delivered,
 *    and never revives a tombstoned one. Within its window (from its first `seq`, or from the
 *    start without `has_more`, up to its `before_seq` for an older page) a page drops a held
 *    message it lacks unless the stream revised it: that message was deleted, or came from
 *    an older saved copy.
 *  - `older` keeps each thread's `has_more` from the oldest page read (`useSessionLogOlder`).
 *  - A streaming put (`status: 'streaming'`) is an ordinary put: the deltas that follow
 *    append to its blocks, and the final put (a higher `rev`) replaces it.
 *
 * `rev` only. The API orders revisions by `(generation, rev)`; a frame carries no
 * generation, and `rev` (`max(now µs, last + 1)`) already rises across boots.
 * `revs` keeps one number per message id the session ever had, tombstones included: it
 * grows with the session's own history and goes with `dropSessionLog`.
 * Every record is validated (`guard.ts`) before it is stored; an invalid one is dropped.
 */
import { isSessionLogMessage, isSessionLogThreadHead } from './guard';
import { normalizeShellExits } from './shell-exit';
import type { SessionLogPage } from './source';
import type { SessionLog, SessionLogMessage, SessionLogThread } from './types';

export type SessionLogThreadHead = Omit<SessionLogThread, 'messages'>;
export type SessionLogSessionRecord = Omit<SessionLog, 'threads'>;

export interface SessionLogState {
  generation: number;
  session: Partial<SessionLogSessionRecord>;
  threads: Record<string, SessionLogThreadHead>;
  messages: Record<string, SessionLogMessage[]>;
  revs: Record<string, number>;
  /** Per thread: the oldest page read said older messages exist (`has_more`). Absent before a page of the thread. */
  older: Record<string, boolean>;
}

/** The `log.*` frame as the store receives it: the runtime event shape, with the wire's own event id. */
export interface SessionLogEventInput {
  type: string;
  properties: unknown;
  id?: string;
}

export const EMPTY_SESSION_LOG_STATE: SessionLogState = Object.freeze({
  generation: 0,
  session: {},
  threads: {},
  messages: {},
  revs: {},
  older: {},
});

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRev = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** The thread that holds message `id`, if any. */
function threadOfMessage(state: SessionLogState, id: string): string | undefined {
  for (const [thread, list] of Object.entries(state.messages)) if (list.some((m) => m.message_id === id)) return thread;
  return undefined;
}

function without(state: SessionLogState, id: string): Record<string, SessionLogMessage[]> {
  const thread = threadOfMessage(state, id);
  if (thread === undefined) return state.messages;
  return { ...state.messages, [thread]: state.messages[thread]!.filter((m) => m.message_id !== id) };
}

/**
 * `message` in its thread, by `seq`, replacing any copy of the same id. Every message enters
 * here, from a page or a frame: a shell command that exited non-zero is stored as one
 * (`normalizeShellExits`, KRTX-3021).
 */
function put(messages: Record<string, SessionLogMessage[]>, received: SessionLogMessage): Record<string, SessionLogMessage[]> {
  const message = normalizeShellExits(received);
  const list = (messages[message.thread_id] ?? []).filter((m) => m.message_id !== message.message_id);
  let at = list.length;
  while (at > 0 && list[at - 1]!.seq > message.seq) at--;
  list.splice(at, 0, message);
  return { ...messages, [message.thread_id]: list };
}

function applyMessage(state: SessionLogState, p: unknown): SessionLogState {
  if (!isObj(p) || !isRev(p.rev)) return state;
  if ('message' in p) {
    if (!isSessionLogMessage(p.message)) return state;
    const id = p.message.message_id;
    if ((state.revs[id] ?? -1) >= p.rev) return state;
    return { ...state, messages: put(without(state, id), p.message), revs: { ...state.revs, [id]: p.rev } };
  }
  if (typeof p.message_id !== 'string' || (state.revs[p.message_id] ?? -1) >= p.rev) return state;
  return { ...state, messages: without(state, p.message_id), revs: { ...state.revs, [p.message_id]: p.rev } };
}

function applyDelta(state: SessionLogState, p: unknown): SessionLogState {
  if (!isObj(p) || typeof p.delta !== 'string' || typeof p.thread_id !== 'string') return state;
  const list = state.messages[p.thread_id];
  const at = list?.findIndex((m) => m.message_id === p.message_id) ?? -1;
  if (!list || at < 0) return state;
  const message = list[at]!;
  const index = message.blocks.findIndex((b) => b.id === p.block_id);
  const block = message.blocks[index];
  if (!block || (block.type !== 'text' && block.type !== 'reasoning')) return state;
  const blocks = message.blocks.slice();
  blocks[index] = { ...block, text: block.text + p.delta };
  const next = list.slice();
  next[at] = { ...message, blocks };
  return { ...state, messages: { ...state.messages, [p.thread_id]: next } };
}

export function applySessionLogEvent(state: SessionLogState, event: SessionLogEventInput): SessionLogState {
  const p = event.properties;
  switch (event.type) {
    case 'log.message':
      return applyMessage(state, p);
    case 'log.block.delta':
      return applyDelta(state, p);
    case 'log.thread':
      return isSessionLogThreadHead(p) ? { ...state, threads: { ...state.threads, [p.thread_id]: p } } : state;
    case 'log.state':
      if (!isObj(p) || !isRev(p.generation) || p.generation < state.generation || !isObj(p.session)) return state;
      return { ...state, generation: p.generation, session: { ...state.session, ...p.session } };
    default:
      return state;
  }
}

/**
 * `beforeSeq`: the page answers `before_seq` (an older page); it then settles only below it.
 * Without it the page is the newest one of its thread.
 */
export function applySessionLogPage(state: SessionLogState, page: SessionLogPage, beforeSeq?: number): SessionLogState {
  let messages = state.messages;
  let older = state.older;
  const thread = page.thread_id;
  const held = thread === null ? undefined : messages[thread];
  if (thread !== null) {
    // The page answers for the thread's older messages when it reaches back as far as the
    // held ones: an older page, the first page of the thread, or a page holding all of it.
    // The newest page read again after older pages (a reconnect) does not undo their answer.
    const first = page.messages[0]?.seq;
    const oldest = beforeSeq !== undefined || !held?.length || !page.has_more || (first !== undefined && first <= held[0]!.seq);
    if (oldest && state.older[thread] !== page.has_more) older = { ...older, [thread]: page.has_more };
  }
  // The page is the thread's truth from its first seq (from the start without `has_more`) up to
  // `beforeSeq`: a held message there that it lacks and that the stream never revised was
  // deleted, or came from an older copy (the device's saved copy). It leaves.
  if (thread !== null && held) {
    const from = page.has_more ? (page.messages[0]?.seq ?? Infinity) : -Infinity;
    const to = beforeSeq ?? Infinity;
    const kept = new Set(page.messages.map((m) => m.message_id));
    const settled = held.filter((m) => m.seq < from || m.seq >= to || kept.has(m.message_id) || state.revs[m.message_id] !== undefined);
    if (settled.length !== held.length) messages = { ...messages, [thread]: settled };
  }
  for (const message of page.messages) {
    if (!isSessionLogMessage(message) || state.revs[message.message_id] !== undefined) continue;
    messages = put(messages, message);
  }
  const threads = { ...state.threads };
  for (const head of page.threads) if (isSessionLogThreadHead(head)) threads[head.thread_id] = head;
  // A page is a snapshot: only a newer generation overrides the session fields the stream
  // delivered; at the same or an older one, it fills only the fields the state lacks.
  const newer = page.generation > state.generation;
  return {
    ...state,
    generation: Math.max(page.generation, state.generation),
    session: newer ? { ...state.session, ...page.session } : { ...page.session, ...state.session },
    threads,
    messages,
    older,
  };
}

const logs = new WeakMap<SessionLogState, SessionLog | null>();
/** The thread built from a head and its message list: a frame that touches neither keeps the thread object. */
const joined = new WeakMap<SessionLogThreadHead, { messages: SessionLogMessage[] | undefined; thread: SessionLogThread }>();

function threadOf(head: SessionLogThreadHead, messages: SessionLogMessage[] | undefined): SessionLogThread {
  const cached = joined.get(head);
  if (cached && cached.messages === messages) return cached.thread;
  const thread = { ...head, messages: messages ?? [] };
  joined.set(head, { messages, thread });
  return thread;
}

/**
 * The whole record: threads in arrival order, each with its messages. Null before the session record is known.
 * A thread keeps its identity while its head and its message list are unchanged, so a delta to one
 * thread re-renders no consumer of another.
 */
export function selectSessionLog(state: SessionLogState): SessionLog | null {
  const cached = logs.get(state);
  if (cached !== undefined) return cached;
  const session = state.session.session_id === undefined ? null : (state.session as SessionLogSessionRecord);
  const log = session && {
    ...session,
    threads: Object.values(state.threads).map((head) => threadOf(head, state.messages[head.thread_id])),
  };
  logs.set(state, log);
  return log;
}

/** One thread with its messages; the root thread when `threadId` is omitted. */
export function selectSessionLogThread(state: SessionLogState, threadId?: string | null): SessionLogThread | null {
  const threads = selectSessionLog(state)?.threads ?? [];
  return threads.find((t) => (threadId ? t.thread_id === threadId : t.parent_thread_id === null)) ?? null;
}
