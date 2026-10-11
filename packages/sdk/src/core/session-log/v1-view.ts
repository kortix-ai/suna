/**
 * The v1 rows (`{ info, parts }`, `kortix.transcript.v1`) of a session-log thread, for the
 * hooks that render v1 (`useSessionMessages`, `useSession().messages`, `classifyTurn`).
 * Each message converts with `toV1`, the same conversion the API's v1 projection uses, and
 * its rows are cached on the message object: a row keeps its identity while its message is
 * unchanged, so a memoized row component re-renders only for the message that changed.
 *
 * Rows come in v1 order (`time.created`, then id), as `toV1` returns a thread.
 *
 * The v1 store still holds what the session log does not carry yet: the turn that is
 * streaming (the journal sends a message at turn end) and an optimistic send. Those rows
 * are merged in, by message id: a session-log message replaces the v1 row of the same id,
 * a tombstoned id stays out, and every other v1 row goes where the v1 store orders it
 * (`time.created`, then id; a row with no time goes last).
 */
import type { Message, Part } from '../runtime/runtime-types';
import type { SessionLogState, SessionLogThreadHead } from './store';
import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, type SessionLog, type SessionLogMessage } from './types';
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

const messageRows = new WeakMap<SessionLogMessage, { head: SessionLogThreadHead; rows: V1MessageRow[] }>();

function rowsOf(head: SessionLogThreadHead, message: SessionLogMessage): V1MessageRow[] {
  const cached = messageRows.get(message);
  if (cached?.head === head) return cached.rows;
  const { rows } = toV1({ ...SHELL, threads: [{ ...head, messages: [message] }] });
  const out = rows.map((r) => ({ info: r.info as unknown as Message, parts: r.parts as unknown as Part[] }));
  messageRows.set(message, { head, rows: out });
  return out;
}

/** The thread whose runtime session id is `runtimeSessionId`: its own id, or the native id its ext names. */
function findThread(
  logs: Record<string, SessionLogState>,
  runtimeSessionId: string,
): { state: SessionLogState; head: SessionLogThreadHead; list: SessionLogMessage[] } | null {
  for (const state of Object.values(logs)) {
    for (const id of new Set([...Object.keys(state.threads), ...Object.keys(state.messages)])) {
      const head = state.threads[id] ?? ({ thread_id: id } as SessionLogThreadHead);
      const native = Object.values(head.ext ?? {}).some((e) => e.native_id === runtimeSessionId);
      if (id === runtimeSessionId || native) return { state, head, list: state.messages[id] ?? NO_MESSAGES };
    }
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
  { v1Rows: readonly V1MessageRow[]; head: SessionLogThreadHead; revs: SessionLogState['revs']; result: V1MessageRow[] }
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
  if (cached && cached.v1Rows === v1Rows && cached.head === head && cached.revs === state.revs) return cached.result as R[];
  // v1 order, as `toV1` sorts a whole thread: `time.created` (none first), then id. `seq` can disagree (pi stamps coarse times).
  const result = list.flatMap((m) => rowsOf(head, m)).sort(v1Order);
  const shown = new Set(result.map((r) => r.info.id));
  for (const row of v1Rows) {
    if (shown.has(row.info.id) || state.revs[row.info.id] !== undefined) continue;
    result.splice(insertAt(result, row), 0, row);
  }
  merged.set(list, { v1Rows, head, revs: state.revs, result });
  return result as R[];
}
