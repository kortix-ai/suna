/**
 * The daemon-to-API wire of the session log (P2.2 serves it, kortixd's journal sends it).
 *
 * Journal: `POST /v1/projects/:p/sessions/:s/log/journal`, sandbox token, body
 * `SessionLogJournalRequest` as JSON with `Content-Encoding: gzip`, at most 1 MB gzipped.
 * - 200 `SessionLogJournalResponse`: the `(message_id, rev)` pairs of puts and tombstones,
 *   after commit. A pair not listed is not durable.
 * - 409 `SessionLogJournalConflict`: the request's `generation` is older than the session's
 *   (a zombie box). The daemon stops journaling for this boot.
 * - 503: the operator switch is off. The daemon keeps its dirty set and retries later.
 * - 404: the API predates the route. The daemon stops journaling for this boot.
 *
 * The body above 2 MB gzipped or 16 MB raw answers 413. A batch that reuses a `seq` another
 * message of the same thread holds answers 422 `SessionLogJournalSeqConflict` and writes nothing:
 * `seq` is never reused in a thread, and a tombstone keeps its seq. The daemon drops the batch.
 * One exception: a row the API's transcript capture wrote for a box without a journal (P2.7,
 * rev below 2^31) is provisional. A put that claims its seq replaces it and answers 200.
 *
 * Manifest: `GET /v1/projects/:p/sessions/:s/log/manifest`, sandbox token, answers
 * `SessionLogManifest` for the boot reconcile: the session's `generation` (0 before the first
 * batch) and every stored message with its last `rev` and `content_hash` (`sha256:` and the hex
 * digest of the stored message JSON). A tombstoned message stays listed with `deleted: true`, so
 * the reconcile does not send it again.
 *
 * A tombstone of a message the API never stored is acknowledged and stores nothing.
 *
 * Read (P4.2): `GET /v1/projects/:p/sessions/:s/log?thread=<thread_id>&before_seq=<n>&limit=<n>`,
 * the caller's session read permission (the transcript route's), never the sandbox credential.
 * It reads Postgres only, never the box, and is served whether or not the `session_log` flag is
 * on. 200 `SessionLogPage`: one page of one thread. 404 when the session has no stored log, or when
 * `thread` is not one of its threads.
 *
 * `rev` is monotonic per message across daemon boots, not a per-boot counter: the daemon
 * issues `max(Date.now() * 1000, last + 1)`, a safe integer that needs a `bigint` column. The
 * API applies the highest `rev` it has seen for a message (a lower or equal one changes
 * nothing) and acknowledges every `(message_id, rev)` pair of the batch it has seen, applied
 * or not. A tombstone is a revision too: a put with a lower `rev` does not revive the message.
 */
import { z } from 'zod';
import { SessionLogMessageSchema, SessionLogSchema, SessionLogThreadSchema } from './schema';

const rev = z.number().int().nonnegative();
const messageId = z.string().min(1);

/** One message revision: the whole message. A higher `rev` of the same message replaces it. */
export const SessionLogPutSchema = z.object({ rev, message: SessionLogMessageSchema });
/** A deleted message, as a revision of its own. */
export const SessionLogTombstoneSchema = z.object({ message_id: messageId, rev });
/** A thread without its messages; the messages travel as puts. */
export const SessionLogThreadUpsertSchema = SessionLogThreadSchema.omit({ messages: true });
/** Session fields that changed; threads travel as thread upserts. */
export const SessionLogSessionPatchSchema = SessionLogSchema.omit({ threads: true }).partial();

export const SessionLogJournalRequestSchema = z.object({
  generation: z.number().int().nonnegative(),
  puts: z.array(SessionLogPutSchema),
  tombstones: z.array(SessionLogTombstoneSchema),
  threads: z.array(SessionLogThreadUpsertSchema),
  session: SessionLogSessionPatchSchema.optional(),
});
export const SessionLogAckSchema = z.object({ message_id: messageId, rev });
export const SessionLogJournalResponseSchema = z.object({ acked: z.array(SessionLogAckSchema) });
export const SessionLogJournalConflictSchema = z.object({ generation: z.number().int().nonnegative() });

export const SessionLogJournalSeqConflictSchema = z.object({
  error: z.literal('seq_conflict'),
  message_id: messageId,
  rev,
  thread_id: z.string().min(1),
  seq: z.number().int(),
});

export const SessionLogManifestSchema = z.object({
  generation: z.number().int().nonnegative(),
  messages: z.array(z.object({ message_id: messageId, content_hash: z.string().min(1), rev, deleted: z.boolean() })),
});

/**
 * One page of the stored log.
 * - `session`: the session record without `threads`, as the journal's session patches built it
 *   (a field the daemon has not sent yet is absent). `generation`: the session's generation.
 * - `threads`: every thread of the session, without `messages`.
 * - `thread_id`: the paged thread, `thread` or else the root thread (null: no thread stored).
 * - `messages`: that thread's newest `limit` messages (default 40, at most 500) with
 *   `seq < before_seq`, ascending by `seq`. A tombstoned message is left out; its seq is a gap.
 * - `has_more`: an older message exists. Read it with `before_seq` = the first message's `seq`.
 */
export const SessionLogPageSchema = z.object({
  session: SessionLogSessionPatchSchema,
  generation: z.number().int().nonnegative(),
  threads: z.array(SessionLogThreadUpsertSchema),
  thread_id: z.string().nullable(),
  messages: z.array(SessionLogMessageSchema),
  has_more: z.boolean(),
});

export type SessionLogPut = z.infer<typeof SessionLogPutSchema>;
export type SessionLogTombstone = z.infer<typeof SessionLogTombstoneSchema>;
export type SessionLogThreadUpsert = z.infer<typeof SessionLogThreadUpsertSchema>;
export type SessionLogSessionPatch = z.infer<typeof SessionLogSessionPatchSchema>;
export type SessionLogJournalRequest = z.infer<typeof SessionLogJournalRequestSchema>;
export type SessionLogAck = z.infer<typeof SessionLogAckSchema>;
export type SessionLogJournalResponse = z.infer<typeof SessionLogJournalResponseSchema>;
export type SessionLogJournalConflict = z.infer<typeof SessionLogJournalConflictSchema>;
export type SessionLogJournalSeqConflict = z.infer<typeof SessionLogJournalSeqConflictSchema>;
export type SessionLogManifest = z.infer<typeof SessionLogManifestSchema>;
export type SessionLogPage = z.infer<typeof SessionLogPageSchema>;
