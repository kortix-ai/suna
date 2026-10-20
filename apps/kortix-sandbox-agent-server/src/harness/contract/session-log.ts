/**
 * The session-log port: what a harness adapter implements so kortixd can save
 * the session as `kortix.session/2` (`@kortix/api-contract/session-log`) and put
 * it back into a fresh box. `shared/session-log-journal.ts` drives it: it pulls
 * `changes`, guards them by hash, and posts them to apps/api.
 *
 * Schema rule C13: export is incremental and hash-guarded. The adapter returns
 * each message with `native_hash`, a digest of the message as its harness
 * stores it. The journal keeps one `ExportCursor` per thread and drops a
 * message whose hash equals the cursor's, so a message that did not change in
 * the native store is never sent again. `restore` returns the cursors of what
 * it wrote: a restored record is not re-derived from a lossy native store and
 * sent back over the record the API already holds.
 */
import type {
  AdapterCapabilities,
  ExportCursor,
  SessionLog,
  SessionLogMessage,
  SessionLogSessionPatch,
  SessionLogThreadUpsert,
} from '@kortix/api-contract/session-log'
import type { BytesReader } from '../shared/session-log-restore'

/** A message read from the native store, with the digest of its native form. */
export interface ExportedMessage {
  message: SessionLogMessage
  native_hash: string
}

/** What changed in the native store since the cursors. */
export interface SessionLogChanges {
  /**
   * Messages after each thread's `last_seq`, plus any earlier one that may have
   * changed (a streaming message, a compaction that took messages out of
   * context). In thread order. Sending an unchanged message is harmless: the
   * journal drops it by hash.
   */
  messages: ExportedMessage[]
  /** Ids of messages the native store no longer holds. */
  tombstones: string[]
  /** May include unchanged threads: the journal skips one equal to the last it collected. */
  threads: SessionLogThreadUpsert[]
  /** Session fields that changed (title, selection, todos, pending, harness). */
  session?: SessionLogSessionPatch
}

/** What `restore` wrote. */
export interface SessionLogRestoreResult {
  /** One per thread written, holding the native hash of every message the next export derives from the store. */
  cursors: ExportCursor[]
  /**
   * Model-visible content of the log that the native store cannot hold, as counts by kind
   * (for example `attachment`: an image with no bytes). Empty when the next request equals
   * `modelView(log)`. The boot decides on a notice from it (decision D3).
   */
  dropped: Record<string, number>
}

export interface SessionLogPort {
  /** What this adapter renders, natively and by lowering (C12, F9). */
  readonly capabilities: AdapterCapabilities
  /** Changes since `cursors`: one per thread the journal has seen; a thread without one is new. */
  changes(cursors: readonly ExportCursor[]): Promise<SessionLogChanges>
  /**
   * Write `log` into the native store before the harness starts. Returns one
   * cursor per thread, holding the native hash of every message written, and
   * what it could not write. `seqMax` is the highest seq the API holds per
   * thread, tombstones included (the restore answer's `seq_max`): the harness
   * numbers every new message above it. `readAttachment` replaces the reader the port was
   * built with (the boot passes the bytes it read beside the texts).
   */
  restore(log: SessionLog, seqMax?: Readonly<Record<string, number>>, readAttachment?: BytesReader): Promise<SessionLogRestoreResult>
  /**
   * For the boot reconcile (P6.4, `shared/session-log-boot.ts`): the ids of every message the
   * native store holds, plus the ids it held and deleted (a revert) that the journal may not
   * have tombstoned yet. Null when the store is missing or cannot be trusted (no store, no
   * pinned root, a lost seq map): the boot reads null as behind the log.
   */
  held(): Promise<ReadonlySet<string> | null>
  /**
   * What a message of the live turn (P4.3b) has in its turn end's record that
   * its v1 frames do not carry: the seq it has, or gets when the harness
   * stores it, and `created_at` when the harness times the message itself.
   * Null while the harness cannot know the seq yet. The journal's streaming
   * puts carry these, so they equal the turn end's record.
   */
  live(threadId: string, messageId: string): { seq: number; created_at?: string } | null
  /**
   * The bytes behind an attachment the last `changes` exported as `ref: blob:<sha256>`, or null
   * when the store no longer has them. The journal uploads them and writes the stored object's
   * `kortix-attachment://` ref into the record (P2.13). Without it every attachment keeps `blob:`.
   */
  blob?(sha256: string): Buffer | null
}
