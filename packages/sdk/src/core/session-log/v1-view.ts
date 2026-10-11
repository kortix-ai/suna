/**
 * The v1 rows (`{ info, parts }`, `kortix.transcript.v1`) of a `fromV1` session-log thread
 * (the OpenCode adapter's records; see `findThread` for the others), for the hooks that render v1 (`useSessionMessages`, `useSession().messages`, `classifyTurn`).
 * Each message converts with `toV1`, the same conversion the API's v1 projection uses, and
 * its rows are cached on the message object: a row keeps its identity while its message is
 * unchanged, so a memoized row component re-renders only for the message that changed.
 *
 * Rows come in v1 order (`time.created`, then id), as `toV1` returns a thread.
 *
 * The v1 store still holds what the session log does not carry yet: an optimistic send, and,
 * until P4.4 relays `schema=v2` (the v1 frames keep arriving until then), the turn that is
 * streaming. Those rows
 * are merged in, by message id: a session-log message replaces the v1 row of the same id,
 * a tombstoned id stays out, and every other v1 row goes where the v1 store orders it
 * (`time.created`, then id; a row with no time goes last).
 */
import type { Message, Part } from '../runtime/runtime-types';
import type { SessionLogState, SessionLogThreadHead } from './store';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLog, type SessionLogMessage } from './types';
import { KORTIX_TRANSCRIPT_SCHEMA } from '../runtime/transcript-types';
import { toV1 } from './v1';

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
/** A thread `fromV1` built (the OpenCode adapter's records): the only kind the v1 hooks read through `toV1`. */
export const isV1Thread = (head: SessionLogThreadHead | undefined): boolean => !!head && v1Ext(head) !== undefined;
/** The runtime session id `toV1` gives the thread's rows: the v1 ext's native id, else the thread id. */
const nativeOf = (head: SessionLogThreadHead) => {
  const e = v1Ext(head);
  return e ? (e.native_id ?? null) : head.thread_id;
};

/** Rows per message, valid for one runtime session id: a `log.thread` upsert keeps them. */
const messageRows = new WeakMap<SessionLogMessage, { native: string | null; rows: V1MessageRow[] }>();

function rowsOf(head: SessionLogThreadHead, message: SessionLogMessage): V1MessageRow[] {
  const native = nativeOf(head);
  const cached = messageRows.get(message);
  if (cached && cached.native === native) return cached.rows;
  const { rows } = toV1({ ...SHELL, threads: [{ ...head, messages: [message] }] });
  const out = rows.map((r) => ({ info: r.info as unknown as Message, parts: r.parts as unknown as Part[] }));
  messageRows.set(message, { native, rows: out });
  return out;
}

/** Runtime session id -> thread id of each `fromV1` thread, built once per state. */
const indexes = new WeakMap<SessionLogState, Map<string, string>>();

function indexOf(state: SessionLogState): Map<string, string> {
  let index = indexes.get(state);
  if (!index) {
    index = new Map();
    for (const head of Object.values(state.threads)) {
      const native = v1Ext(head) ? nativeOf(head) : null;
      if (native !== null && !index.has(native)) index.set(native, head.thread_id);
    }
    indexes.set(state, index);
  }
  return index;
}

/**
 * The `fromV1` thread whose runtime session id is `runtimeSessionId`. Only such a thread
 * reads through `toV1`, as the API's v1 reads do: a native record (the pi adapter writes
 * its records without the v1 residuals) renders lossy through `toV1`, so its v1 hooks keep
 * the v1 store rows.
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

const v1Order = (a: V1MessageRow, b: V1MessageRow) =>
  (createdOf(a) ?? -Infinity) - (createdOf(b) ?? -Infinity) || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0);

const merged = new WeakMap<
  SessionLogMessage[],
  { v1Rows: readonly V1MessageRow[]; native: string | null; revs: SessionLogState['revs']; result: V1MessageRow[] }
>();

/**
 * The rows the v1 hooks show for runtime session `runtimeSessionId`. `v1Rows` (the v1
 * store's rows) come back as the same array when no session log holds that thread.
 */
export function sessionLogRowsFor<R extends V1MessageRow>(
  logs: Record<string, SessionLogState>,
  runtimeSessionId: string,
  v1Rows: R[],
): R[] {
  const found = findThread(logs, runtimeSessionId);
  if (!found) return v1Rows;
  const { state, head, list } = found;
  const cached = merged.get(list);
  const native = nativeOf(head);
  if (cached && cached.v1Rows === v1Rows && cached.native === native && cached.revs === state.revs) return cached.result as R[];
  // v1 order, as `toV1` sorts a whole thread: `time.created` (none first), then id. `seq` can disagree (pi stamps coarse times).
  const result = list.flatMap((m) => rowsOf(head, m)).sort(v1Order);
  const shown = new Set(result.map((r) => r.info.id));
  for (const row of v1Rows) {
    if (shown.has(row.info.id) || state.revs[row.info.id] !== undefined) continue;
    result.splice(insertAt(result, row), 0, row);
  }
  merged.set(list, { v1Rows, native, revs: state.revs, result });
  return result as R[];
}
