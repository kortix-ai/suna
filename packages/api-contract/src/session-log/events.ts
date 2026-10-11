/**
 * The session log on the live runtime stream (P4.3): the `log.*` frames of
 * `GET /kortix/runtime/events?schema=v2`. A daemon that serves them lists `session.log.v2`
 * in `/kortix/health` `capabilities`. Without `schema` (or with `schema=v1`) the stream
 * carries the v1 frames only, unchanged.
 *
 * The v2 stream has its own sequence and epoch (`kortix.hello` names them). The daemon
 * derives every frame from the records its journal sends to the API (`wire.ts`): the same
 * message ids, block ids, `seq`, thread ids and `rev`, so a client merges the stream with
 * the saved pages by keeping the highest `rev` of each message. While a turn runs, a
 * `log.message` put with `status: 'streaming'` precedes the first delta of a message (the
 * API never stores it); a later put with a higher `rev` replaces it.
 *
 * | Frame | Payload | When |
 * | --- | --- | --- |
 * | `log.state` | `SessionLogStateEventSchema` | the session fields changed (journal start, turn end) |
 * | `log.thread` | `SessionLogThreadUpsertSchema` | a thread is new or changed |
 * | `log.message` | `SessionLogMessageEventSchema` | the journal collected a new revision of a message (`{ rev, message }`), or its tombstone (`{ message_id, rev }`, the journal's own form); or a live put of the running turn |
 * | `log.block.delta` | `SessionLogBlockDeltaEventSchema` | the harness streamed text into a text or reasoning block |
 *
 * In one collection the order is `log.state`, then `log.thread`, then `log.message`.
 *
 * The API session stream (`GET /v1/projects/:p/sessions/:s/events?schema=v2`, P4.4) carries these
 * frames in place of the v1 transcript frames (`V1_TRANSCRIPT_EVENTS`, `live.ts`). It relays them
 * from a daemon that lists `session.log.v2`; for an older daemon the API converts the v1 frames
 * (`liveMessageFromV1`, block id = part id, seq = `v1Seqs`), and `log.thread` is never sent.
 */
import { z } from 'zod';
import { SessionLogPutSchema, SessionLogSessionPatchSchema, SessionLogThreadUpsertSchema, SessionLogTombstoneSchema } from './wire';

const id = z.string().min(1);

/** The session fields that changed, under the generation the journal writes. */
export const SessionLogStateEventSchema = z.object({
  generation: z.number().int().nonnegative(),
  session: SessionLogSessionPatchSchema,
});

/** A whole message at `rev` (a put, with `message`), or its tombstone `{ message_id, rev }`: the message is deleted at `rev`. */
export const SessionLogMessageEventSchema = z.union([SessionLogPutSchema, SessionLogTombstoneSchema]);

/**
 * Text appended to a text or reasoning block: `block_id` is that block's `id` in the record
 * of message `message_id`. A client appends the delta until the next `log.message` of that
 * message replaces the whole record.
 */
export const SessionLogBlockDeltaEventSchema = z.object({ thread_id: id, message_id: id, block_id: id, delta: z.string() });

/** The payload schema of each `log.*` frame. */
export const SESSION_LOG_EVENTS = {
  'log.state': SessionLogStateEventSchema,
  'log.thread': SessionLogThreadUpsertSchema,
  'log.message': SessionLogMessageEventSchema,
  'log.block.delta': SessionLogBlockDeltaEventSchema,
} as const;
export type SessionLogEventType = keyof typeof SESSION_LOG_EVENTS;

export type SessionLogStateEvent = z.infer<typeof SessionLogStateEventSchema>;
export type SessionLogMessageEvent = z.infer<typeof SessionLogMessageEventSchema>;
export type SessionLogBlockDeltaEvent = z.infer<typeof SessionLogBlockDeltaEventSchema>;
