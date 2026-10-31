/**
 * The v1 rows (`{ info, parts }`, `kortix.transcript.v1`) of a session-log thread, `fromV1`
 * (the OpenCode adapter's records) or native (the pi adapter's), for the hooks that render v1
 * (`useSessionMessages`, `useSession().messages`, `classifyTurn`).
 * Each message converts with `toV1`, the same conversion the API's v1 projection uses, and
 * its rows are cached on the message object: a row keeps its identity while its message is
 * unchanged, so a memoized row component re-renders only for the message that changed.
 *
 * Rows come in v1 order (`time.created`, then id), as `toV1` returns a thread.
 *
 * The v1 store still holds what the session log does not carry yet: an optimistic send, and
 * the rows it held before the stream switched to `schema=v2`. Those rows
 * are merged in, by message id: a session-log message replaces the v1 row of the same id,
 * a tombstoned id stays out, and every other v1 row goes where the v1 store orders it
 * (`time.created`, then id; a row with no time goes last).
 */
import type { Message, Part } from '../runtime/runtime-types';
import type { SessionLogState, SessionLogThreadHead } from './store';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type GradeCounts, type SessionLog, type SessionLogBlock, type SessionLogMessage, type SessionLogThread } from './types';
import { KORTIX_TRANSCRIPT_SCHEMA } from '../runtime/transcript-types';
import { fromV1, toV1 } from './v1';

export interface V1MessageRow {
  info: Message;
  parts: Part[];
}

const SHELL: Omit<SessionLog, 'threads'> = {
  schema: SESSION_LOG_SCHEMA,
  v: SESSION_LOG_MINOR,
  session_id: '',
  title: null,
  created_at: '',
  restore_grade: 'native',
  harness: { current: '', history: [] },
  selection: { agent: null, model: null },
  todos: [],
  pending: { questions: [], permissions: [] },
};

/** One array for every thread with no messages, so the merge cache below can hold it. */
const NO_MESSAGES: SessionLogMessage[] = [];

/** The `fromV1` mark: the thread carries an ext entry of version `kortix.transcript.v1`. */
const v1Ext = (head: SessionLogThreadHead) => Object.values(head.ext ?? {}).find((e) => e.version === KORTIX_TRANSCRIPT_SCHEMA);
/** A thread `fromV1` built (the OpenCode adapter's records), as opposed to a native one (pi). */
export const isV1Thread = (head: SessionLogThreadHead | undefined): boolean => !!head && v1Ext(head) !== undefined;
/** The runtime session id `toV1` gives the thread's rows: the v1 ext's native id, else the thread id. */
const nativeOf = (head: SessionLogThreadHead) => {
  const e = v1Ext(head);
  return e ? (e.native_id ?? null) : head.thread_id;
};

/**
 * The root thread of `state` (a page or the saved copy is in): the runtime session id its v1
 * rows are keyed by, whether it holds a message, and whether a page proved it empty (no
 * message, nothing older). Null before any page, or when the log names no root thread.
 */
export function sessionLogRoot(state: SessionLogState | undefined): { runtimeSessionId: string | null; hasMessages: boolean; empty: boolean } | null {
  const head = state && Object.values(state.threads).find((h) => h.parent_thread_id === null);
  if (!state || !head) return null;
  const hasMessages = (state.messages[head.thread_id]?.length ?? 0) > 0;
  return { runtimeSessionId: nativeOf(head), hasMessages, empty: !hasMessages && state.older[head.thread_id] === false };
}

/** Rows per message, valid for one runtime session id: a `log.thread` upsert keeps them. */
const messageRows = new WeakMap<SessionLogMessage, { native: string | null; rows: V1MessageRow[] }>();

/** The v1 rows `toV1` gives `message` in the thread `head` (a compaction gives two: the marker, then its summary). Internal. */
export function rowsOf(head: SessionLogThreadHead, message: SessionLogMessage): V1MessageRow[] {
  const native = nativeOf(head);
  const cached = messageRows.get(message);
  if (cached && cached.native === native) return cached.rows;
  const { rows } = toV1({ ...SHELL, threads: [{ ...head, messages: [message] }] });
  const out = rows.map((r) => ({ info: r.info as unknown as Message, parts: r.parts as unknown as Part[] }));
  messageRows.set(message, { native, rows: out });
  return out;
}

/** Runtime session id -> thread id of each thread, built once per thread record (a message frame keeps it). */
const indexes = new WeakMap<SessionLogState['threads'], Map<string, string>>();

function indexOf(state: SessionLogState): Map<string, string> {
  let index = indexes.get(state.threads);
  if (!index) {
    index = new Map();
    for (const head of Object.values(state.threads)) {
      const native = nativeOf(head);
      if (native !== null && !index.has(native)) index.set(native, head.thread_id);
    }
    indexes.set(state.threads, index);
  }
  return index;
}

/** The id of the thread whose runtime session id is `runtimeSessionId`. Internal. */
export const sessionLogThreadIdOf = (state: SessionLogState, runtimeSessionId: string): string | undefined => indexOf(state).get(runtimeSessionId);

/**
 * The thread whose runtime session id is `runtimeSessionId`. A native thread (pi) reads
 * through `toV1` too: the v1 store gets no frame on `schema=v2`. Its rows carry what the
 * blocks map (a call's `details` as its `state.metadata`), not the pi-only ext data.
 */
function findThread(
  logs: Record<string, SessionLogState>,
  runtimeSessionId: string,
): { state: SessionLogState; head: SessionLogThreadHead; list: SessionLogMessage[] } | null {
  for (const state of Object.values(logs)) {
    const threadId = indexOf(state).get(runtimeSessionId);
    if (threadId !== undefined) return { state, head: state.threads[threadId]!, list: state.messages[threadId] ?? NO_MESSAGES };
  }
  return null;
}

const createdOf = (row: V1MessageRow) => (row.info as { time?: { created?: number } }).time?.created;

/** Where the v1 store would put `row` among `rows`: before the first strictly newer one. */
function insertAt(rows: readonly V1MessageRow[], row: V1MessageRow): number {
  const created = createdOf(row);
  if (created === undefined) return rows.length;
  const at = rows.findIndex((other) => {
    const t = createdOf(other);
    return t !== undefined && (t > created || (t === created && other.info.id > row.info.id));
  });
  return at < 0 ? rows.length : at;
}

/** Where `message` goes among `messages` by `created_at` (the v1 rule of `insertAt`): before the first strictly newer one. */
function messageInsertAt(messages: readonly SessionLogMessage[], message: SessionLogMessage): number {
  const created = Date.parse(message.created_at);
  if (!Number.isFinite(created)) return messages.length;
  const at = messages.findIndex((other) => {
    const t = Date.parse(other.created_at);
    return Number.isFinite(t) && (t > created || (t === created && other.message_id > message.message_id));
  });
  return at < 0 ? messages.length : at;
}

const v1Order = (a: V1MessageRow, b: V1MessageRow) =>
  (createdOf(a) ?? -Infinity) - (createdOf(b) ?? -Infinity) || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0);

/** The sorted rows of a thread's last message list, per thread head. */
const ownRows = new WeakMap<SessionLogThreadHead, { list: SessionLogMessage[]; native: string | null; own: V1MessageRow[] }>();
/** Above this many changed messages, a list change re-sorts instead of patching in place. */
const PATCH_LIMIT = 4;

const sameKeys = (a: readonly V1MessageRow[], b: readonly V1MessageRow[]) =>
  a.length === b.length && a.every((row, i) => row.info.id === b[i]!.info.id && createdOf(row) === createdOf(b[i]!));

/**
 * `prev.own` with the rows of the messages that changed between `prev.list` and `list` swapped
 * in place, or undefined when that is not the sort: another length, another id at an index, a
 * changed row's id or time (its sort key), or more than `PATCH_LIMIT` changes. A streamed delta
 * changes one message's text, so its rows keep their place and nothing re-sorts (KRTX-2880).
 */
function patchOwn(head: SessionLogThreadHead, prev: { list: SessionLogMessage[]; own: V1MessageRow[] }, list: SessionLogMessage[]): V1MessageRow[] | undefined {
  if (prev.list.length !== list.length) return undefined;
  let own: V1MessageRow[] | undefined;
  let changes = 0;
  for (let i = 0; i < list.length; i++) {
    const before = prev.list[i]!;
    const after = list[i]!;
    if (before === after) continue;
    if (++changes > PATCH_LIMIT || before.message_id !== after.message_id) return undefined;
    const old = rowsOf(head, before);
    const next = rowsOf(head, after);
    if (!sameKeys(old, next)) return undefined;
    own ??= prev.own.slice();
    for (let r = 0; r < old.length; r++) {
      const at = own.indexOf(old[r]!);
      if (at < 0) return undefined;
      own[at] = next[r]!;
    }
  }
  return own ?? prev.own;
}

/** The thread's own rows, in v1 order (`time.created`, none first, then id), as `toV1` sorts a whole thread. `seq` can disagree (pi stamps coarse times). */
function ownRowsOf(head: SessionLogThreadHead, list: SessionLogMessage[], native: string | null): V1MessageRow[] {
  const prev = ownRows.get(head);
  if (prev && prev.list === list && prev.native === native) return prev.own;
  const own = (prev && prev.native === native && patchOwn(head, prev, list)) || list.flatMap((m) => rowsOf(head, m)).sort(v1Order);
  ownRows.set(head, { list, native, own });
  return own;
}

const merged = new WeakMap<
  SessionLogMessage[],
  { v1Rows: readonly V1MessageRow[]; native: string | null; revs: SessionLogState['revs']; own: V1MessageRow[]; extra: V1MessageRow[]; result: V1MessageRow[] }
>();

/**
 * The rows the v1 hooks show for runtime session `runtimeSessionId`. `v1Rows` (the v1
 * store's rows) come back as the same array when no session log holds that thread.
 */
/**
 * The id the runtime echoes an optimistic row under, when the control plane re-minted it
 * (`optimisticEchoOf` in the sync store): the log holds the prompt under that id, and the v2
 * stream carries no v1 echo that would retire the row.
 */
export type OptimisticEchoOf = (id: string) => string | undefined;

/** `row` is one the log holds (by its id or its echo id) or a tombstoned one. */
function heldByLog(row: V1MessageRow, held: ReadonlySet<string>, revs: SessionLogState['revs'], echoOf?: OptimisticEchoOf): boolean {
  const id = row.info.id;
  if (held.has(id) || revs[id] !== undefined) return true;
  const echo = echoOf?.(id);
  return echo !== undefined && (held.has(echo) || revs[echo] !== undefined);
}

export function sessionLogRowsFor<R extends V1MessageRow>(
  logs: Record<string, SessionLogState>,
  runtimeSessionId: string,
  v1Rows: R[],
  echoOf?: OptimisticEchoOf,
): R[] {
  const found = findThread(logs, runtimeSessionId);
  if (!found) return v1Rows;
  const { state, head, list } = found;
  const cached = merged.get(list);
  const native = nativeOf(head);
  const own = cached && cached.v1Rows === v1Rows && cached.native === native && cached.revs === state.revs ? cached.own : ownRowsOf(head, list, native);
  const shown = new Set(own.map((r) => r.info.id));
  const extra = v1Rows.filter((row) => !heldByLog(row, shown, state.revs, echoOf));
  if (cached && cached.own === own && cached.extra.length === extra.length && cached.extra.every((r, i) => r === extra[i])) return cached.result as R[];
  const result = [...own];
  for (const row of extra) result.splice(insertAt(result, row), 0, row);
  merged.set(list, { v1Rows, native, revs: state.revs, own, extra, result });
  return result as R[];
}

const extended = new WeakMap<SessionLogThread, { held: Set<string>; extra: V1MessageRow[]; result: SessionLogThread }>();

/**
 * `thread` (a thread of `state`) with the v1 store rows the log does not hold, as `fromV1` live
 * messages placed by time as `sessionLogRowsFor` places them (an older page `loadOlder` read
 * goes before the log's messages, an optimistic send after them). The log's messages keep
 * their `seq`; an added one numbers after the last. An optimistic send shows until the log's
 * put of the same id, or of the id the control plane re-minted it under (`echoOf`), replaces it.
 * A compaction marker and its summary row are one message, as on v1 (pi keeps no failed
 * compaction in its store, so only the v1 rows hold it).
 * A row the log holds, or tombstoned, stays out. The thread itself when no row is added; the
 * same thread while the same rows are added; a message keeps its identity while its row is
 * unchanged.
 */
export function sessionLogThreadWithV1Rows(state: SessionLogState, thread: SessionLogThread, v1Rows: readonly V1MessageRow[], echoOf?: OptimisticEchoOf): SessionLogThread {
  const cached = extended.get(thread);
  // The ids the log's rows carry: a compaction message also gives its summary row.
  const held = cached?.held ?? new Set(thread.messages.flatMap((m) => rowsOf(thread, m).map((r) => r.info.id)));
  const extra = v1Rows.filter((r) => !heldByLog(r, held, state.revs, echoOf));
  if (cached && cached.extra.length === extra.length && cached.extra.every((r, i) => r === extra[i])) return cached.result;
  let result = thread;
  if (extra.length) {
    let seq = thread.messages[thread.messages.length - 1]?.seq ?? 0;
    const { paired, used } = pairCompactions(extra);
    const messages = [...thread.messages];
    for (const r of extra) {
      if (used.has(r)) continue;
      const message = convert(state.session.session_id ?? '', thread.thread_id, r, paired.get(r), ++seq).message;
      messages.splice(messageInsertAt(messages, message), 0, message);
    }
    result = { ...thread, messages };
  }
  extended.set(thread, { held, extra, result });
  return result;
}

// ─── v1 rows -> session log (v2 not negotiated) ──────────────────────────────

type Converted = { sum: V1MessageRow | undefined; seq: number; message: SessionLogMessage; lost: GradeCounts };
/** The message of a row (with the summary row folded into its compaction marker), valid for one runtime session id. */
const converted = new WeakMap<V1MessageRow, Converted & { sessionId: string; native: string }>();
const views = new WeakMap<readonly V1MessageRow[], { sessionId: string; native: string; log: SessionLog }>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const iso = (ms: number | undefined) => (ms !== undefined && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null);
const isMarker = (row: V1MessageRow) => row.info.role === 'user' && row.parts.some((p) => isObj(p) && p.type === 'compaction');
const summaryOf = (row: V1MessageRow, marker: V1MessageRow) => {
  const info = row.info as { role?: string; summary?: unknown; parentID?: unknown };
  return info.role === 'assistant' && info.summary === true && info.parentID === marker.info.id;
};

/**
 * The block each part object last converted to, with what else it depends on (the runtime session,
 * the message id and time, its index and id). A changed row reuses the block of every part object
 * it still holds, so a streamed text delta does not replace the message's tool-call blocks. A
 * compaction block also reads the summary row, so it is never reused.
 */
const partBlocks = new WeakMap<object, { key: string; block: SessionLogBlock }>();

function reuseBlocks(native: string, row: V1MessageRow, message: SessionLogMessage): SessionLogMessage {
  const info = row.info as { id?: unknown; time?: { created?: unknown } };
  const at = `${native}|${String(info.id)}|${String(info.time?.created)}`;
  let reused = false;
  const blocks = message.blocks.map((block, i) => {
    const part = row.parts[i];
    if (!isObj(part) || block.type === 'compaction') return block;
    const key = `${at}|${i}|${block.id}`;
    const prev = partBlocks.get(part);
    if (prev && prev.key === key) {
      reused = true;
      return prev.block;
    }
    partBlocks.set(part, { key, block });
    return block;
  });
  return reused ? { ...message, blocks } : message;
}

/** A compaction marker and its summary row are one message, as `fromV1` pairs them. */
function pairCompactions(rows: readonly V1MessageRow[]): { paired: Map<V1MessageRow, V1MessageRow>; used: Set<V1MessageRow> } {
  const paired = new Map<V1MessageRow, V1MessageRow>();
  const used = new Set<V1MessageRow>();
  for (const row of rows) {
    if (!isMarker(row)) continue;
    const sum = rows.find((r) => !used.has(r) && summaryOf(r, row));
    if (!sum) continue;
    paired.set(row, sum);
    used.add(sum);
  }
  return { paired, used };
}

function convert(sessionId: string, native: string, row: V1MessageRow, sum: V1MessageRow | undefined, seq: number): Converted {
  const cached = converted.get(row);
  if (cached && cached.sessionId === sessionId && cached.native === native && cached.sum === sum && cached.seq === seq) return cached;
  const unit = sum ? [row, sum] : [row];
  const log = fromV1(
    { session_id: sessionId, root_id: native, rows: unit.map((r) => ({ runtime_session_id: native, info: r.info as never, parts: r.parts as never })) },
    { live: true },
  );
  const message = reuseBlocks(native, row, log.threads[0]!.messages[0]!);
  const entry = { sessionId, native, sum, seq, message: { ...message, seq }, lost: log.grade_counts! };
  converted.set(row, entry);
  return entry;
}

/**
 * The session log of one runtime session's v1 store rows: what `fromV1(…, { live: true })`
 * builds for them (one root thread, the runtime session id as its id), so a host reads blocks
 * while the session reads v1. The open turn stays open: its calls keep `pending`/`running`.
 * Each message is converted once per row object and keeps its identity while its row is
 * unchanged; the same `rows` array gives the same log.
 */
export function sessionLogOfV1Rows(sessionId: string, runtimeSessionId: string, rows: readonly V1MessageRow[]): SessionLog {
  const cached = views.get(rows);
  if (cached && cached.sessionId === sessionId && cached.native === runtimeSessionId) return cached.log;
  const sorted = [...rows].sort(v1Order);
  const { paired, used } = pairCompactions(sorted);
  const counts: GradeCounts = { tool_input: 0, cut_point: 0, attachment: 0 };
  const messages: SessionLogMessage[] = [];
  for (const row of sorted) {
    if (used.has(row)) continue;
    const entry = convert(sessionId, runtimeSessionId, row, paired.get(row), messages.length + 1);
    for (const k of ['tool_input', 'cut_point', 'attachment'] as const) counts[k] += entry.lost[k];
    messages.push(entry.message);
  }
  const created = iso(sorted.map(createdOf).find((t): t is number => typeof t === 'number' && Number.isFinite(t))) ?? '';
  const users = messages.filter((m) => m.role === 'user' && m.kind === 'turn');
  const log: SessionLog = {
    ...SHELL,
    session_id: sessionId,
    created_at: created,
    restore_grade: counts.tool_input + counts.cut_point + counts.attachment > 0 ? 'partial' : 'converted',
    grade_counts: counts,
    harness: { current: 'opencode', history: [] },
    selection: { agent: users.at(-1)?.agent ?? null, model: users.at(-1)?.model ?? null },
    threads: [{
      schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: runtimeSessionId, parent_thread_id: null, spawned_by: null,
      agent: users[0]?.agent ?? null, title: null, created_at: messages[0]?.created_at || created, messages,
      ext: { opencode: { version: KORTIX_TRANSCRIPT_SCHEMA, native_id: runtimeSessionId } },
    }],
  };
  views.set(rows, { sessionId, native: runtimeSessionId, log });
  return log;
}
