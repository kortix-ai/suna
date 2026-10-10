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
 * Manifest: `GET /v1/projects/:p/sessions/:s/log/manifest`, sandbox token, answers
 * `SessionLogManifest` for the boot reconcile.
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

export const SessionLogManifestSchema = z.object({
  messages: z.array(z.object({ message_id: messageId, content_hash: z.string().min(1) })),
});

export type SessionLogPut = z.infer<typeof SessionLogPutSchema>;
export type SessionLogTombstone = z.infer<typeof SessionLogTombstoneSchema>;
export type SessionLogThreadUpsert = z.infer<typeof SessionLogThreadUpsertSchema>;
export type SessionLogSessionPatch = z.infer<typeof SessionLogSessionPatchSchema>;
export type SessionLogJournalRequest = z.infer<typeof SessionLogJournalRequestSchema>;
export type SessionLogAck = z.infer<typeof SessionLogAckSchema>;
export type SessionLogJournalResponse = z.infer<typeof SessionLogJournalResponseSchema>;
export type SessionLogJournalConflict = z.infer<typeof SessionLogJournalConflictSchema>;
export type SessionLogManifest = z.infer<typeof SessionLogManifestSchema>;
