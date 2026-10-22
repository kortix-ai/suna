/**
 * The session log on the API session stream (P4.4): `GET .../events?schema=v2`.
 *
 * A daemon that lists `session.log.v2` serves the `log.*` frames itself; the stream relays its
 * `?schema=v2` stream and drops any v1 transcript frame (`dropV1Transcript`). For an older
 * daemon, `createV1LogConverter` turns the v1 transcript frames into `log.*` frames with the
 * payload schemas of `SESSION_LOG_EVENTS` and passes every other frame through unchanged:
 *
 * | v1 frame | `log.*` frame |
 * | --- | --- |
 * | `message.updated`, `message.part.updated`, `message.part.removed` | `log.message` put: `liveMessageFromV1` of the message's frames so far |
 * | `message.part.delta` (`field: 'text'`) | `log.block.delta`, `block_id` = the v1 part id |
 * | `message.removed` | `log.message` tombstone `{ message_id, rev }` |
 * | `session.updated` of a root (no `parentID`) | the frame itself, then `log.state` `{ generation: 0, session: { title } }` |
 *
 * A converted frame keeps the v1 envelope (`seq`, `at`, `session`) and changes `type` and
 * `payload`, so the client's cursor stays the daemon's v1 cursor. `session.updated` and its
 * `log.state` share one seq.
 *
 * `rev`: `max(now µs, last + 1)` per API process, the journal's shape, so it rises within a
 * stream and across a reconnect to this process.
 *
 * `seq`: what `fromV1` gives the message (`v1Seqs`) over the stored session log's v1 rows plus the
 * frames of the running turn, so a put and the record the capture of a box without a journal
 * stores for the same message agree (`writeSessionLogFromRead`). The log is read on the first
 * message that needs a seq and again after each `kortix.turn` (the capture runs at the turn end).
 * A message `fromV1` folds into another (a compaction summary) has no seq and gets no put.
 *
 * Limits: a part frame replayed after a reconnect for a message whose `message.updated` came before
 * the cursor waits for that message's next `message.updated`. A delta extends the cached part, so a
 * delta lost in a gap shows until the next put of that message.
 */
import {
  isV1TranscriptEvent,
  liveMessageFromV1,
  v1Seqs,
  type SessionLogBlockDeltaEvent,
  type SessionLogMessageEvent,
  type SessionLogStateEvent,
  type V1Row,
} from '@kortix/api-contract/session-log';
import type { KortixMessageInfo, KortixPart } from '@kortix/api-contract/transcript';
import { readCapturedSessionLog } from '../session-log-capture';

type J = Record<string, any>;
export type RuntimeEnvelope = Record<string, unknown>;
/** The stored history `v1Seqs` reads: the v1 root and rows. */
export type V1Mirror = { root_id: string | null; rows: V1Row[] };
type Row = { info: KortixMessageInfo | null; parts: Map<string, KortixPart & J> };

/** Live messages one stream keeps. A turn needs a few; the capture holds the rest. */
const MAX_LIVE_MESSAGES = 500;

let lastRev = 0;
/** The journal's rev shape: monotonic in this process, microseconds. */
export const nextRev = (): number => (lastRev = Math.max(Date.now() * 1000, lastRev + 1));

/** The v2 relay of a daemon that serves `log.*` itself: never a v1 transcript frame. */
export const dropV1Transcript = (envelope: RuntimeEnvelope): RuntimeEnvelope[] =>
  isV1TranscriptEvent(String(envelope.type)) ? [] : [envelope];

/** The session log's v1 rows and root, as `v1Seqs` needs them (no v1 mirror table is read). */
export async function readStoredV1ForSeqs(sessionId: string): Promise<V1Mirror> {
  const { rows, root_id } = await readCapturedSessionLog(sessionId);
  return { root_id, rows };
}

/**
 * The converter of one stream: call it with each daemon envelope, in order; it answers the
 * envelopes to write. `readMirror` is the seam the tests replace.
 */
export function createV1LogConverter(options: {
  sessionId: string;
  harness?: 'opencode' | 'pi';
  readMirror?: (sessionId: string) => Promise<V1Mirror>;
}): (envelope: RuntimeEnvelope) => Promise<RuntimeEnvelope[]> {
  const { sessionId, harness = 'opencode', readMirror = readStoredV1ForSeqs } = options;
  const live = new Map<string, Row>();
  const removed = new Set<string>();
  const seqs = new Map<string, number>();
  let mirror: Promise<V1Mirror> | null = null;

  const rowOf = (id: string): Row => {
    const row = live.get(id) ?? { info: null, parts: new Map() };
    live.delete(id);
    live.set(id, row);
    // ponytail: least recently touched first out; a message older than 500 live ones is captured.
    if (live.size > MAX_LIVE_MESSAGES) live.delete(live.keys().next().value!);
    return row;
  };

  const seqOf = async (id: string): Promise<number | undefined> => {
    if (seqs.has(id)) return seqs.get(id);
    mirror ??= readMirror(sessionId).catch(() => ({ root_id: null, rows: [] }));
    const stored = await mirror;
    const inFlight = [...live.values()].flatMap(({ info, parts }) =>
      info ? [{ runtime_session_id: info.sessionID, info, parts: [...parts.values()] }] : [],
    );
    const skip = new Set([...removed, ...inFlight.map((r) => r.info.id)]);
    const rows = [...stored.rows.filter((r) => !skip.has(String(r.info?.id))), ...inFlight];
    // A seq once sent is kept: the client orders by it.
    for (const [message, seq] of v1Seqs({ session_id: sessionId, root_id: stored.root_id, rows }, { harness })) {
      if (!seqs.has(message)) seqs.set(message, seq);
    }
    return seqs.get(id);
  };

  const put = async (id: string): Promise<Array<{ type: string; payload: SessionLogMessageEvent }>> => {
    const row = live.get(id);
    if (!row?.info) return [];
    const seq = await seqOf(id);
    if (seq === undefined) return [];
    const message = liveMessageFromV1({ info: row.info, parts: [...row.parts.values()] }, { seq }, harness);
    return [{ type: 'log.message', payload: { rev: nextRev(), message } }];
  };

  return async (envelope) => {
    const p = (envelope.payload ?? {}) as J;
    const as = (frames: Array<{ type: string; payload: unknown }>) => frames.map((f) => ({ ...envelope, ...f }));
    switch (envelope.type) {
      case 'kortix.turn':
        mirror = null; // the turn end's capture changed it
        return [envelope];
      case 'message.updated': {
        const info = p.info as KortixMessageInfo | undefined;
        if (typeof info?.id !== 'string' || typeof info.sessionID !== 'string') return [];
        rowOf(info.id).info = info;
        return as(await put(info.id));
      }
      case 'message.part.updated': {
        const part = p.part as (KortixPart & J) | undefined;
        if (typeof part?.id !== 'string' || typeof part.messageID !== 'string') return [];
        rowOf(part.messageID).parts.set(part.id, structuredClone(part));
        return as(await put(part.messageID));
      }
      case 'message.part.removed': {
        if (!live.get(String(p.messageID))?.parts.delete(String(p.partID))) return [];
        return as(await put(String(p.messageID)));
      }
      case 'message.part.delta': {
        const { sessionID: thread_id, messageID: message_id, partID: block_id, delta } = p;
        if (p.field !== 'text' || typeof delta !== 'string') return [];
        if (typeof thread_id !== 'string' || typeof message_id !== 'string' || typeof block_id !== 'string') return [];
        const part = live.get(message_id)?.parts.get(block_id);
        if (part && typeof part.text === 'string') part.text += delta;
        return as([{ type: 'log.block.delta', payload: { thread_id, message_id, block_id, delta } satisfies SessionLogBlockDeltaEvent }]);
      }
      case 'message.removed': {
        if (typeof p.messageID !== 'string') return [];
        live.delete(p.messageID);
        removed.add(p.messageID);
        return as([{ type: 'log.message', payload: { message_id: p.messageID, rev: nextRev() } satisfies SessionLogMessageEvent }]);
      }
      case 'session.updated': {
        const info = p.info as J | undefined;
        if (!info || typeof info.id !== 'string' || info.parentID) return [envelope];
        const state: SessionLogStateEvent = { generation: 0, session: { title: typeof info.title === 'string' ? info.title : null } };
        return [envelope, ...as([{ type: 'log.state', payload: state }])];
      }
      default:
        return isV1TranscriptEvent(String(envelope.type)) ? [] : [envelope];
    }
  };
}
