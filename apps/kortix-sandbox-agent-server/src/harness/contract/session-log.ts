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
  threads: SessionLogThreadUpsert[]
  /** Session fields that changed (title, selection, todos, pending, harness). */
  session?: SessionLogSessionPatch
}

export interface SessionLogPort {
  /** What this adapter renders, natively and by lowering (C12, F9). */
  readonly capabilities: AdapterCapabilities
  /** Changes since `cursors`: one per thread the journal has seen; a thread without one is new. */
  changes(cursors: readonly ExportCursor[]): Promise<SessionLogChanges>
  /**
   * Write `log` into the native store before the harness starts. Returns one
   * cursor per thread, holding the native hash of every message written.
   */
  restore(log: SessionLog): Promise<ExportCursor[]>
  /** A digest of the whole native store, for the boot reconcile. */
  fingerprint(): Promise<string>
}
