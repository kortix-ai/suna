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
 *    not hold is dropped: the journal sends the message at turn end.
 *  - `log.thread`: the thread head replaces the one held.
 *  - `log.state`: an older `generation` (a zombie box) is ignored; the session fields merge.
 *  - A page carries no revs: a page message never replaces a message the stream delivered,
 *    and never revives a tombstoned one.
 * Every record is validated (`guard.ts`) before it is stored; an invalid one is dropped.
 */
import { isSessionLogMessage, isSessionLogThreadHead } from './guard';
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
}

/** The `log.*` frame as the store receives it: the runtime event shape. */
export interface SessionLogEventInput {
  type: string;
  properties: unknown;
}

export const EMPTY_SESSION_LOG_STATE: SessionLogState = Object.freeze({
  generation: 0,
  session: {},
  threads: {},
  messages: {},
  revs: {},
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

/** `message` in its thread, by `seq`, replacing any copy of the same id. */
function put(messages: Record<string, SessionLogMessage[]>, message: SessionLogMessage): Record<string, SessionLogMessage[]> {
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

export function applySessionLogPage(state: SessionLogState, page: SessionLogPage): SessionLogState {
  let messages = state.messages;
  for (const message of page.messages) {
    if (!isSessionLogMessage(message) || state.revs[message.message_id] !== undefined) continue;
    messages = put(messages, message);
  }
  const threads = { ...state.threads };
  for (const head of page.threads) if (isSessionLogThreadHead(head)) threads[head.thread_id] = head;
  const newer = page.generation >= state.generation;
  return {
    ...state,
    generation: newer ? page.generation : state.generation,
    session: newer ? { ...state.session, ...page.session } : { ...page.session, ...state.session },
    threads,
    messages,
  };
}

/**
 * Does `state` own this frame? True when it holds the frame's thread (or, for a new
 * thread, its parent), the tombstoned message, or the session the `log.state` names.
 * `sync-store` routes a `log.*` frame to the one session that owns it.
 */
export function ownsSessionLogEvent(state: SessionLogState, event: SessionLogEventInput): boolean {
  const p = event.properties;
  if (!isObj(p)) return false;
  const holds = (thread: unknown) => typeof thread === 'string' && (thread in state.threads || thread in state.messages);
  switch (event.type) {
    case 'log.state':
      return isObj(p.session) && p.session.session_id !== undefined && p.session.session_id === state.session.session_id;
    case 'log.thread':
      return holds(p.thread_id) || holds(p.parent_thread_id);
    case 'log.message':
      if (isObj(p.message)) return holds(p.message.thread_id);
      return typeof p.message_id === 'string' && (p.message_id in state.revs || threadOfMessage(state, p.message_id) !== undefined);
    default:
      return holds(p.thread_id);
  }
}

const logs = new WeakMap<SessionLogState, SessionLog | null>();

/** The whole record: threads in arrival order, each with its messages. Null before the session record is known. */
export function selectSessionLog(state: SessionLogState): SessionLog | null {
  const cached = logs.get(state);
  if (cached !== undefined) return cached;
  const session = state.session.session_id === undefined ? null : (state.session as SessionLogSessionRecord);
  const log = session && {
    ...session,
    threads: Object.values(state.threads).map((head) => ({ ...head, messages: state.messages[head.thread_id] ?? [] })),
  };
  logs.set(state, log);
  return log;
}

/** One thread with its messages; the root thread when `threadId` is omitted. */
export function selectSessionLogThread(state: SessionLogState, threadId?: string | null): SessionLogThread | null {
  const threads = selectSessionLog(state)?.threads ?? [];
  return threads.find((t) => (threadId ? t.thread_id === threadId : t.parent_thread_id === null)) ?? null;
}
