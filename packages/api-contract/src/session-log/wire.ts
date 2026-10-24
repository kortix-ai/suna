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
 * The body above 2 MB gzipped or 16 MB raw answers 413: the daemon sends smaller batches, and cuts the
 * longest strings of a single message over the cap. A body the schema rejects answers 400 with the zod
 * `issues`: the daemon drops the puts, tombstones and threads they name and sends the rest. A batch that
 * reuses a `seq` another message of the same thread holds answers 422 `SessionLogJournalSeqConflict` and
 * writes nothing: `seq` is never reused in a thread, and a tombstone keeps its seq. `seq_max` is the
 * thread's highest stored seq, tombstones included. The daemon numbers that thread above it from then on
 * and sends the batch again; no batch is dropped. One exception: a row the API's transcript capture wrote for a box without a journal (P2.7,
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
 * the caller's session read permission, the transcript route's gate (a session-bound token included).
 * It reads Postgres only, never the box. 200 `SessionLogPage`: one page of one thread. 404 `{ error,
 * code: 'session_log_missing' }` when the session has no stored log yet (a client stays on the log;
 * an API without this route answers 404 with no code), and 404 when `thread` is not one of its threads. A session whose history is
 * only in the old v1 mirror is converted to the log first (P8.2); 503 `{ error, code:
 * 'session_log_converting' }` with `Retry-After: 60` when that history is over the conversion size
 * cap and the backfill has not converted it yet.
 *
 * Restore (P6.1): `POST /v1/projects/:p/sessions/:s/log/restore`, sandbox token only, no body.
 * The daemon of a fresh box calls it once, before its harness starts. It claims the session:
 * under the session's advisory lock it raises `session_logs.generation` by 1 and answers
 * `SessionLogRestore` at that generation, so a box still journaling at the old generation gets
 * 409 and stops. Send `Accept-Encoding: gzip`: the answer is gzipped when it is over 1 kB.
 * - 200 `SessionLogRestore`: `generation` (the box journals under it from now on), `log` (every
 *   thread with its live messages in `seq` order, `in_context: false` ones included, tombstoned
 *   ones left out), `revs` (the stored `rev` of every message, tombstoned ones included; any rev
 *   at the claimed generation wins over them), `seq_max` (the highest seq of each thread,
 *   tombstoned messages included: number new messages above it) and `blobs` (each text the
 *   API stored by reference: the record holds its 16 kB preview; read the full text with `GET /v1/projects/:p/sessions/:s/attachments/<id>`,
 *   the id being the last segment of `ref`, and check `sha256`).
 * - 413 `SessionLogRestoreTooLarge`: the restore is over `SESSION_LOG_RESTORE_MAX_BYTES` (`bytes`, the
 *   live messages' stored JSON lengths plus 2/5 of the session's live blob bytes, against `limit`). The claim still happens, so the box
 *   journals above it: the answer is `SessionLogRestore` with every thread and no message, every
 *   rev, `seq_max` and no blob, plus `messages` (the live messages left out). The box writes the D3
 *   note alone into its root and boots: the model does not see the earlier conversation.
 * - 404 `SessionLogRestoreMissing`: the session has no stored log; nothing was claimed. Boot
 *   without a restore. A 404 with another body is an API that predates the route.
 * - 503: the operator switch `SESSION_LOG_RESTORE_ENABLED` is off; nothing was claimed.
 *
 * Switch preflight (P7.1): `POST /v1/projects/:p/sessions/:s/log/switch-preflight`, body
 * `{ to: 'pi' | 'opencode' }`, the caller's session read permission (the `GET …/log` gate). Read
 * only: it claims nothing and changes nothing. 200 `SessionLogSwitchPreflight`: whether the switch
 * can happen (`available`, `reason`) and restores the log (`restores`), what the session would lose
 * (`losses`) and everything `to` lacks (`unsupported`) (`switchPreflight`, `capabilities.ts`). A
 * switch that cannot happen is still a 200, so a client can show why. 404 when the session has no
 * stored log.
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
  seq_max: z.number().int(),
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

/** A text the API stored by reference (F3): `ref` names its object in the session's own folder. */
export const SessionLogRestoreBlobSchema = z.object({
  message_id: messageId,
  /** The text block, or the tool call whose result holds the text. */
  block_id: z.string().min(1),
  ref: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const SessionLogRestoreSchema = z.object({
  generation: z.number().int().positive(),
  log: SessionLogSchema,
  revs: z.record(rev),
  /** The highest seq each thread holds, tombstoned messages included; the box numbers new messages above it. Absent from an API before P6.2. */
  seq_max: z.record(z.number().int().nonnegative()).optional(),
  blobs: z.array(SessionLogRestoreBlobSchema),
});
export const SessionLogRestoreMissingSchema = z.object({ error: z.literal('no_session_log') });
export const SessionLogRestoreTooLargeSchema = SessionLogRestoreSchema.extend({
  error: z.literal('session_log_too_large'),
  /** The live messages' stored JSON lengths plus 2/5 of the bytes of the session's live blobs (full texts, attachments), rounded up. */
  bytes: z.number().int().nonnegative(),
  /** The API's `SESSION_LOG_RESTORE_MAX_BYTES`. */
  limit: z.number().int().nonnegative(),
  /** The live messages left out of `log`. */
  messages: z.number().int().nonnegative(),
});

/** A harness a session can run on: the adapters with a capability manifest (`capabilities.ts`). */
export const SessionLogHarnessSchema = z.enum(['pi', 'opencode']);
export const SessionLogSwitchPreflightRequestSchema = z.object({ to: SessionLogHarnessSchema });
/** One thing the target harness handles worse than the source harness (`switchPreflight` in `capabilities.ts`). */
export const SessionLogSwitchGapSchema = z.object({
  /** A `CapabilityFeatures` path (`todos`, `attachments.user`, `compaction`, ...), a `RuntimeCapability` (`session.mcp`, ...), or `history` (no restore). */
  feature: z.string().min(1),
  /** The mime type, compaction kind, sub-agent mode, reasoning kind or tool names the line is about. */
  detail: z.string().min(1).optional(),
  /** `degraded`: the target writes it by lowering or emulating. `lost`: the target cannot write or serve it. */
  status: z.enum(['degraded', 'lost']),
});
/** A gap the log shows in use. */
export const SessionLogSwitchLossSchema = SessionLogSwitchGapSchema.extend({
  /** How many records of the log use it (`history`: live messages). */
  used: z.number().int().positive(),
});
export const SessionLogSwitchPreflightSchema = z.object({
  session_id: z.string(),
  /** `harness.current` of the stored log. */
  from: z.string(),
  to: SessionLogHarnessSchema,
  /** False when the switch cannot happen; `reason` says why. */
  available: z.boolean(),
  /** `same_harness`: the log already runs on `to`. */
  reason: z.enum(['same_harness']).nullable(),
  /** The new box restores the log (`session_log_restore` on, the log under the restore cap). False: it starts without the conversation (`losses` begins with `history`). */
  restores: z.boolean(),
  /** What the session uses that `to` handles worse, with counts. */
  losses: z.array(SessionLogSwitchLossSchema),
  /** Everything the source harness handles that `to` handles worse, used or not (an MCP server never called, shell, fork). */
  unsupported: z.array(SessionLogSwitchGapSchema),
});

export type SessionLogPut = z.infer<typeof SessionLogPutSchema>;
export type SessionLogHarness = z.infer<typeof SessionLogHarnessSchema>;
export type SwitchGap = z.infer<typeof SessionLogSwitchGapSchema>;
export type SwitchLoss = z.infer<typeof SessionLogSwitchLossSchema>;
export type SessionLogSwitchPreflight = z.infer<typeof SessionLogSwitchPreflightSchema>;
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
export type SessionLogRestoreBlob = z.infer<typeof SessionLogRestoreBlobSchema>;
export type SessionLogRestore = z.infer<typeof SessionLogRestoreSchema>;
export type SessionLogRestoreTooLarge = z.infer<typeof SessionLogRestoreTooLargeSchema>;
