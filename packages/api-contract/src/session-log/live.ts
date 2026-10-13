/**
 * The live turn in v1 frames (P4.3b, P4.4). The `message.*` frames of the v1 runtime stream carry
 * the transcript; on the v2 stream (`?schema=v2`) the `log.*` frames replace them, and every other
 * frame stays. `liveMessageFromV1` turns the v1 frames of one message seen so far into the
 * streaming session-log message a `log.message` put carries.
 */
import type { KortixMessageInfo, KortixPart } from '../transcript';
import type { SessionLogMessage } from './types';
import { fromV1, type FromV1Options, type V1Transcript } from './v1';

/** The v1 runtime frames that carry the transcript. */
export const V1_TRANSCRIPT_EVENTS = [
  'message.updated',
  'message.part.updated',
  'message.part.delta',
  'message.removed',
  'message.part.removed',
] as const;
const TRANSCRIPT = new Set<string>(V1_TRANSCRIPT_EVENTS);
export const isV1TranscriptEvent = (type: string): boolean => TRANSCRIPT.has(type);

/**
 * The `seq` of every message `fromV1` builds from `v1`, by message id. The seq rule: `fromV1`
 * numbers the messages of each thread from 1 in the mirror's order (`info.time.created`, then
 * message id), the superseded rows of an old root first, and a compaction summary row folded into
 * its marker's message takes no number (it has no message of its own, so it has no entry here).
 * A live message gets the seq `fromV1` gives it over the stored rows plus the in-flight rows of the
 * running turn: the seq its stored record gets once the capture writes its row.
 */
export function v1Seqs(v1: V1Transcript, options: FromV1Options = {}): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const thread of fromV1(v1, options).threads) for (const m of thread.messages) seqs.set(m.message_id, m.seq);
  return seqs;
}

/**
 * `fromV1` of one message of the running turn (`live: true`): the message is `streaming` while
 * it is open or has an open call (pi completes a reply before its calls run; the rule is `fromV1`'s), an open call keeps
 * its v1 status (`pending`, else `running`) with no result, and a pending call that streams its
 * input carries the text so far as its `input`. The residual is taken against
 * those blocks, so a running call keeps its display metadata (task `sessionId`, bash `command`)
 * and `toV1` gives back the frames. `known` names the fields the v1 frames do not carry: the
 * message's `seq` in its thread, and `created_at` when the harness times the message itself.
 * The thread is `info.sessionID`. The API relay (old daemons) and kortixd both build their live
 * puts with it.
 */
export function liveMessageFromV1(
  row: { info: KortixMessageInfo; parts: KortixPart[] },
  known: { seq: number; created_at?: string },
  harness: FromV1Options['harness'] = 'opencode',
): SessionLogMessage {
  const thread = row.info.sessionID;
  const message = fromV1(
    { session_id: thread, root_id: thread, rows: [{ runtime_session_id: thread, info: row.info, parts: row.parts }] },
    { harness, live: true },
  ).threads[0]!.messages[0]!;
  return Object.assign(message, known);
}
