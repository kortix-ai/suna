/**
 * The session-log control frames as the events this SDK's stores already
 * reduce: `log.status` is a thread's `session.status`, and a `log.state` that
 * carries `pending` asks the requests the pending store lacks and answers the
 * ones the log no longer lists. The stream handler dispatches the result like a
 * runtime event, so a host renders the same status, permission cards and
 * questions whichever frames the box sends.
 */
import { useRuntimePendingStore } from '../../browser/stores/opencode-pending-store';
import type { KortixSessionStatus } from '../../core/runtime/transcript-types';
import type { RuntimePendingRecord } from '../../core/session/runtime-actions';
import type { RuntimeEvent } from './types';

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `log.status` frame as the thread's `session.status` event; null for any other frame. */
export function sessionStatusOfLogFrame(event: { type: string; properties: unknown }): Extract<RuntimeEvent, { type: 'session.status' }> | null {
  if (event.type !== 'log.status' || !isObj(event.properties)) return null;
  const { thread_id: sessionID, status, retry } = event.properties;
  if (typeof sessionID !== 'string' || !sessionID) return null;
  let value: KortixSessionStatus;
  if (status === 'idle') value = { type: 'idle' };
  else if (status === 'busy' || status === 'compacting') value = { type: 'busy' };
  else if (status === 'retry' && isObj(retry)) {
    value = {
      type: 'retry',
      attempt: typeof retry.attempt === 'number' ? retry.attempt : 1,
      message: typeof retry.message === 'string' ? retry.message : '',
      next: typeof retry.next_at === 'string' ? Date.parse(retry.next_at) : Date.now(),
    };
  } else return null;
  return { type: 'session.status', properties: { sessionID, status: value } } as Extract<RuntimeEvent, { type: 'session.status' }>;
}

function records(value: unknown): RuntimePendingRecord[] {
  return Array.isArray(value)
    ? value.filter((r): r is RuntimePendingRecord => isObj(r) && typeof r.id === 'string' && typeof r.thread_id === 'string')
    : [];
}

/**
 * The interaction events that bring the pending store to a `log.state`'s
 * `pending`. `threads` are the session's thread ids: a request of another
 * session is never answered here. Empty when the frame carries no `pending`.
 */
export function pendingEventsOfLogState(event: { type: string; properties: unknown }, threads: Iterable<string>): RuntimeEvent[] {
  if (event.type !== 'log.state' || !isObj(event.properties) || !isObj(event.properties.session)) return [];
  const pending = event.properties.session.pending;
  if (!isObj(pending)) return [];
  const permissions = records(pending.permissions);
  const questions = records(pending.questions);
  const mine = new Set(threads);
  for (const record of [...permissions, ...questions]) mine.add(record.thread_id);
  const held = useRuntimePendingStore.getState();
  const tool = (record: RuntimePendingRecord) => (record.call_id ? { tool: { messageID: '', callID: record.call_id } } : {});
  const events: unknown[] = [];
  for (const record of permissions) {
    if (held.permissions[record.id]) continue;
    const payload = isObj(record.payload) ? record.payload : {};
    events.push({
      type: 'permission.asked',
      properties: {
        id: record.id,
        sessionID: record.thread_id,
        permission: typeof payload.permission === 'string' ? payload.permission : '',
        patterns: Array.isArray(payload.patterns) ? payload.patterns : [],
        always: Array.isArray(payload.always) ? payload.always : [],
        metadata: isObj(payload.metadata) ? payload.metadata : {},
        ...tool(record),
      },
    });
  }
  for (const record of questions) {
    if (held.questions[record.id]) continue;
    const payload = isObj(record.payload) ? record.payload : {};
    events.push({
      type: 'question.asked',
      properties: { id: record.id, sessionID: record.thread_id, questions: Array.isArray(payload.questions) ? payload.questions : [], ...tool(record) },
    });
  }
  const listed = new Set([...permissions, ...questions].map((record) => record.id));
  for (const request of Object.values(held.permissions)) {
    if (mine.has(request.sessionID) && !listed.has(request.id)) {
      events.push({ type: 'permission.replied', properties: { sessionID: request.sessionID, requestID: request.id, reply: 'once' } });
    }
  }
  for (const request of Object.values(held.questions)) {
    if (mine.has(request.sessionID) && !listed.has(request.id)) {
      events.push({ type: 'question.replied', properties: { sessionID: request.sessionID, requestID: request.id, answers: [] } });
    }
  }
  return events as RuntimeEvent[];
}
