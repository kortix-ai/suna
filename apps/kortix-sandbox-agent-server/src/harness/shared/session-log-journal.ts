/**
 * The session-log journal: the daemon's push of `kortix.session/2` records to
 * `POST /projects/:p/sessions/:s/log/journal` (wire: `@kortix/api-contract/session-log`).
 *
 * - It pulls changes from the adapter's `SessionLogPort`, drops unchanged
 *   messages by native hash (C13) and unchanged threads by their JSON, and
 *   keeps the rest in a dirty set until the API acknowledges their
 *   `(message_id, rev)`.
 * - `rev` is monotonic across boots: `max(Date.now() * 1000, last + 1)`. A
 *   restarted daemon (no restore, same generation) never reuses a rev, so the
 *   API, which keeps the highest rev per message, never keeps stale content.
 * - It posts the dirty set in order, in batches of at most 1 MB gzipped and 8 MB
 *   raw. One message larger than that goes alone; one over the route's cap (2 MB
 *   gzipped, 16 MB raw) has its longest strings cut, longest first, to their first
 *   16 kB and `JOURNAL_TRUNCATION_MARK` until it fits. The native store keeps the
 *   whole message.
 * - Both harnesses' turn-end relays (`relayTurnEnd`, OpenCode's
 *   `relayTurnEndToApi`) and the daemon shutdown call `flush`, which waits at
 *   most 3 s for the acknowledgement, and returns at the first failed post. A
 *   batch not acknowledged by then keeps retrying in the background; the
 *   native store still holds the messages.
 * - Network errors, 401, 408, 429 and 5xx (503: the operator switch is off)
 *   back off exponentially and keep the dirty set. A dead session token (the
 *   KRTX-446 breaker) sends nothing. 404 (an API without the route) and 409 (a
 *   newer generation owns the session: this box is a zombie) turn the journal
 *   off for this boot. No refused batch is dropped:
 *   - 422 `seq_conflict`: a message reuses a seq another message of its thread
 *     holds, and the API wrote nothing. A box whose native store is gone (restore
 *     off) numbers its root from 1 again under the same thread id. The thread's
 *     seqs move above the log: every seq this box exports for it is its native
 *     seq plus `seq_max + 1` (the offset), on the dirty set and on the live
 *     stream, so clients order the new turn after the history. Every message of
 *     the thread is collected again at the new seqs (one this box sent earlier at
 *     a free seq moves too). The offsets persist with the boot state
 *     (`saveSeqOffsets`), so a restarted daemon on the same store keeps them; a
 *     restore writes a store at the log's seqs and clears them. A 422 without a
 *     higher `seq_max` backs off.
 *   - 413: the batch limit halves for this boot (down to 64 kB) and the dirty
 *     set is packed again; at 64 kB it backs off.
 *   - 400: the puts, tombstones and threads the zod `issues` name (and the
 *     session patch) are logged and dropped, and the rest is sent again. A 400
 *     that names nothing (a body that is not gzip or JSON) drops the batch.
 *   - Any other 4xx backs off and keeps the dirty set.
 *   A 200 that does not acknowledge a batch is retried 3 times, then its pairs
 *   are dropped (an API bug). A dropped message stays in the native store.
 *
 * Live stream (P4.3): each collection publishes what it put in the dirty set
 * on `sessionLogEventBus()`, the bus of `/kortix/runtime/events?schema=v2`
 * (payloads: `@kortix/api-contract/session-log` `SESSION_LOG_EVENTS`):
 * `log.state` for the session patch, `log.thread` for each changed thread,
 * then `log.message` for each put (`{ rev, message }`) and each tombstone
 * (`{ message_id, rev }`, as the journal posts it), with the revs the API receives. The
 * journal collects when it starts (the native store is at rest), at each turn
 * end and at the daemon stop. A journal the API turned off (404, 409)
 * collects and publishes nothing more, deltas included. While it runs, every `message.part.delta` text
 * frame on the v1 bus is published as `log.block.delta`: both harnesses use the
 * v1 session id, message id and part id as the thread, message and block id.
 *
 * Live turn (P4.3b): the journal also folds the v1 frames of each message it
 * has not collected yet. On the first `message.updated` of a message and on
 * each `message.part.updated` of a new part, it publishes a `log.message` put
 * of that message on the v2 bus only (never the dirty set); so does an update
 * of a tool part that changes its status, its metadata keys (P4.7) or the status of
 * a call in its `metadata.calls` (a codemode script's calls): `fromV1` of the
 * frames so far (`liveMessageFromV1`: `status: 'streaming'`, open calls stay
 * open and keep their v1 residual, so a running task keeps its `sessionId`),
 * with the seq (and `created_at`) the adapter's `live` names. It
 * is built in the bus listener, before the next frame, so its text is exactly
 * the deltas published before it. A message whose seq the adapter cannot know
 * yet waits for the next live frame. The collection's put of the message has
 * a higher rev and ends its live puts. A live message the harness removes
 * before the collection (`message.removed`) gets the journal-form tombstone
 * if a put of it went out; a removed part (`message.part.removed`) a fresh put.
 *
 * Attachment bytes (P2.13). An adapter exports an image or file as `ref: blob:<sha256>`; its
 * bytes are only in the native store. A collection starts one attachment pass over the sha256s
 * this boot has not settled (unless a pass still runs) and waits for it at most 10 s
 * (`JOURNAL_BLOB_BUDGET_MS`) before its records enter the dirty set; the pass goes on after that.
 * The pass asks the API for each sha256 (`GET …/log/blobs/<sha256>`, 4 at a time), then uploads
 * the bytes `port.blob` returns for each one the API lacks (`PUT`, at most 50 MiB, one at a time:
 * the API takes one upload per session). The ref the API answers
 * (`kortix-attachment://<project>/<session>/<id>`) replaces `blob:` in the record, so a record names
 * only an object that exists, and a fresh box's restore reads it back. A settled sha256 is not
 * asked again in the boot (`blobRefs`); the API stores it once per session. A record whose
 * attachment is not settled when the wait ends goes out with `blob:`, and its cursor hash is
 * cleared, so the next collection exports it again with the ref the pass found, or retries.
 * - The API is down or busy (a failed lookup, a network error on it, a 429 or 401 on either
 *   call): the pass stops. Nothing is counted against a sha256.
 * - An upload fails (a 5xx, a 408, a network error or the 95 s deadline): one failure in a pass
 *   counts against its sha256, and after 3 the sha256 keeps `blob:` for the boot. A second
 *   failure stops the pass and none of them counts: two are an outage of Storage or the API.
 * - A 400, 413 or 404 (an API without the route), a body over 50 MiB, bytes the store lost and the
 *   dump directory keep `blob:` for the boot at once: a retry cannot change them.
 *
 * Debug: `KORTIX_SESSION_LOG_DUMP_DIR` (off by default) turns the API into a
 * directory. Each batch body is written there as JSON and acknowledged at
 * once; nothing is posted.
 *
 * Same credential and relay context as every other daemon callback
 * (`sandboxRelayContext`); same backoff as the audit relay (`computeRetryDelay`).
 */
import {
  liveMessageFromV1,
  SessionLogJournalConflictSchema,
  SessionLogJournalSeqConflictSchema,
  type FromV1Options,
  SessionLogJournalResponseSchema,
  type ExportCursor,
  type SessionLog,
  type SessionLogBlockDeltaEvent,
  type SessionLogMessageEvent,
  type SessionLogStateEvent,
  type SessionLogJournalRequest,
  type SessionLogMessage,
  type SessionLogSessionPatch,
  type SessionLogThreadUpsert,
} from '@kortix/api-contract/session-log'
import type { KortixMessageInfo, KortixPart } from '@kortix/api-contract/transcript'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '@/lib/log/logger'
import { kortixEventBus, sessionLogEventBus } from '@/services/event-bus/kortix-event-bus'
import { sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { noteControlPlaneResponse, sessionTokenPresumedDead } from '@/lib/kortix-api/session-token-health'
import type { ExportedMessage, SessionLogChanges, SessionLogPort } from '../contract/session-log'
import { mapLimit } from '@/lib/map-limit'
import { computeRetryDelay, MAX_RETRY_MS_DEFAULT } from './audit-relay'
import { carryHarness, saveSeqOffsets, type HarnessCarry } from './session-log-boot'

export const JOURNAL_MAX_BATCH_BYTES = 1024 * 1024
/** The floor a 413 halves the batch limit to. */
const JOURNAL_MIN_BATCH_BYTES = 64 * 1024
/** The prefix a cut string keeps. */
const JOURNAL_CUT_CHARS = 16 * 1024
/**
 * One post's budget: above the API's 25 s request deadline. At 15 s the daemon gave up on a
 * batch the API was still committing, and re-sent it behind its own lock (KRTX-2344).
 */
export const JOURNAL_POST_TIMEOUT_MS = 30_000
export const JOURNAL_ACK_TIMEOUT_MS = 3_000
/** Posts of one batch that a 200 does not acknowledge, before its pairs are dropped. */
export const JOURNAL_UNACKED_RETRIES = 3
/** The API's cap on one attachment (`MAX_SESSION_ATTACHMENT_BYTES` in `@kortix/shared`, the bucket's `file_size_limit`). */
export const JOURNAL_MAX_BLOB_BYTES = 50 * 1024 * 1024
/** Above the API's 95 s deadline for the upload. */
const JOURNAL_BLOB_TIMEOUT_MS = 120_000
/** Failed uploads of one sha256 before it keeps `blob:` for the boot. */
export const JOURNAL_BLOB_ATTEMPTS = 3
/** Lookups at once. Uploads run one at a time: the API takes one per session. */
const JOURNAL_BLOB_CONCURRENCY = 4
/** How long a collection waits for its attachment pass before its records go on; the pass continues. */
export const JOURNAL_BLOB_BUDGET_MS = 10_000
/** Ends a string the journal cut to fit the route's cap (see the header). */
export const JOURNAL_TRUNCATION_MARK = '[Kortix: the session log keeps the first 16 kB of this text; the whole text is in the sandbox only]'

// The last rev this process issued. A rev follows the clock (1000 per ms), so
// a later boot's revs exceed every rev an earlier boot issued.
let lastRev = 0
function nextRev(): number {
  lastRev = Math.max(Date.now() * 1000, lastRev + 1)
  return lastRev
}

export interface SessionLogJournalOptions {
  /** The session generation this box writes under. */
  generation: number
  /** Cursors `restore` returned; empty on a box that restored nothing. */
  cursors?: readonly ExportCursor[]
  /** Set on every session patch this journal sends: a partial restore's notice (D3, `session-log-boot.ts`). */
  session?: SessionLogSessionPatch
  /** The restored harness history (P7.1, `carryHarness` in `session-log-boot.ts`): replaces the adapter's one-entry history. */
  harness?: HarnessCarry
  /** Per thread, what this box adds to a native seq (a 422 re-sequenced it, see the header). */
  seq_offsets?: Record<string, number>
  /** Test seams. */
  blobBudgetMs?: number
  maxBatchBytes?: number
  retryMs?: number
  maxRetryMs?: number
}

/** A pending revision: a whole message, or a tombstone when `message` is absent. */
type Entry = { id: string; rev: number; message?: SessionLogMessage }
type Batch = { entries: Entry[]; threads: SessionLogThreadUpsert[]; session: SessionLogSessionPatch | null; body: Uint8Array<ArrayBuffer> }
/** A post's outcome: settled, back off, or pack the dirty set again at once (a 400, 413 or 422 changed it). */
type Sent = 'settled' | 'retry' | 'repack'
/** A message of the live turn as its v1 frames describe it; `due` until a live put carries its latest change; `sent` once one went out. */
type LiveRow = { info: KortixMessageInfo | null; parts: Map<string, KortixPart & Record<string, unknown>>; due: boolean; sent: boolean }

export class SessionLogJournal {
  private readonly cursors = new Map<string, ExportCursor>()
  /** Each thread's JSON as last collected: an equal thread is not sent again. */
  private readonly threadJson = new Map<string, string>()
  private readonly tombstoned = new Set<string>()
  private readonly dirty = new Map<string, Entry>()
  private readonly threads = new Map<string, SessionLogThreadUpsert>()
  private session: SessionLogSessionPatch | null = null
  private off: string | null = null
  private stopped = false
  private failures = 0
  /** Consecutive 200s that did not acknowledge the head batch. */
  private unacked = 0
  private inflight: AbortController | null = null
  private draining: Promise<void> | null = null
  private collecting: Promise<void> | null = null
  private recollect = false
  private wakeBackoff: (() => void) | null = null
  /** Flushes waiting for the drain to finish or to start backing off. */
  private waiters: Array<() => void> = []
  private readonly dumpDir = process.env.KORTIX_SESSION_LOG_DUMP_DIR?.trim() || null
  private dumped = 0
  /** The stored object's ref of each attachment sha256 this boot settled; '' = keep `blob:` (see the header). */
  private readonly blobRefs = new Map<string, string>()
  /** Failed uploads per sha256 this boot. */
  private readonly blobFailures = new Map<string, number>()
  /** The attachment pass that runs, at most one. */
  private blobPass: Promise<void> | null = null
  /** The live turn's messages by id, in the order the v1 bus first named them. */
  private readonly live = new Map<string, LiveRow>()
  private readonly seqOffsets: Map<string, number>
  private maxBatch: number
  /** The v1 bus until `stop`: text deltas republished as `log.block.delta`, and the live turn's puts. */
  private readonly offDeltas = kortixEventBus().tap((event) => {
    if (this.off) return
    const p = event.payload as Record<string, any> | null
    if (event.type === 'message.updated') return this.liveMessage(p?.info)
    if (event.type === 'message.part.updated') return this.livePart(p?.part)
    if (event.type === 'message.removed') return this.liveRemoved(p?.messageID)
    if (event.type === 'message.part.removed') return this.livePartRemoved(p?.messageID, p?.partID)
    if (event.type !== 'message.part.delta' || p?.field !== 'text' || typeof p.delta !== 'string') return
    const { sessionID: thread_id, messageID: message_id, partID: block_id } = p
    if (typeof thread_id !== 'string' || typeof message_id !== 'string' || typeof block_id !== 'string') return
    const part = this.live.get(message_id)?.parts.get(block_id)
    if (part && typeof part.text === 'string') part.text += p.delta
    sessionLogEventBus().publish('log.block.delta', { thread_id, message_id, block_id, delta: p.delta } satisfies SessionLogBlockDeltaEvent, thread_id)
  })

  constructor(
    private readonly port: SessionLogPort,
    private readonly options: SessionLogJournalOptions,
  ) {
    for (const cursor of options.cursors ?? []) this.cursors.set(cursor.thread_id, structuredClone(cursor))
    this.seqOffsets = new Map(Object.entries(options.seq_offsets ?? {}))
    this.maxBatch = options.maxBatchBytes ?? JOURNAL_MAX_BATCH_BYTES
  }

  /** The record at the seq the API stores: its native seq plus the thread's offset (see the header). */
  private shifted(message: SessionLogMessage): SessionLogMessage {
    const offset = this.seqOffsets.get(message.thread_id)
    return offset ? { ...message, seq: message.seq + offset } : message
  }

  /** Why the journal is off for this boot (`404`, `409`), or null while it runs. */
  get disabled(): string | null {
    return this.off
  }

  /** True when every collected change is acknowledged. */
  get clean(): boolean {
    return this.dirty.size === 0 && this.threads.size === 0 && this.session === null
  }

  /**
   * Collect the adapter's changes and send them. Resolves within `timeoutMs`,
   * or as soon as the journal backs off (a 503 must not hold every turn end
   * for 3 s): true when everything collected is acknowledged, false otherwise
   * (sending continues in the background).
   */
  async flush(timeoutMs = JOURNAL_ACK_TIMEOUT_MS): Promise<boolean> {
    if (this.off || this.stopped) return false
    const work = this.collect()
      .then(() => {
        if (this.wakeBackoff) return
        const settled = new Promise<void>((resolve) => this.waiters.push(resolve))
        void this.drain()
        return settled
      })
      .catch((err) => logger.warn('[session-log] journal flush failed', { err: String(err) }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    await Promise.race([work, timedOut])
    clearTimeout(timer)
    return this.clean && !this.off
  }

  /** The stop path: one immediate attempt, at most `timeoutMs` (0: none), then no more sends. */
  async stop(timeoutMs = JOURNAL_ACK_TIMEOUT_MS): Promise<void> {
    this.wakeBackoff?.()
    if (timeoutMs > 0) await this.flush(timeoutMs)
    this.stopped = true
    this.offDeltas()
    this.wakeBackoff?.()
    this.inflight?.abort()
    if (!this.clean && !this.off) logger.warn('[session-log] journal stopped with unacknowledged changes', { pending: this.dirty.size })
  }

  /** Collect the adapter's changes into the dirty set and the v2 stream; nothing is sent. */
  collect(): Promise<void> {
    if (this.collecting) {
      this.recollect = true
      return this.collecting
    }
    this.collecting = (async () => {
      do {
        this.recollect = false
        await this.collectOnce().catch((err) => logger.warn('[session-log] export failed', { err: String(err) }))
      } while (this.recollect && !this.stopped)
    })().finally(() => {
      this.collecting = null
    })
    return this.collecting
  }

  private collected(id: string): boolean {
    for (const cursor of this.cursors.values()) if (id in cursor.native_hashes) return true
    return false
  }

  private row(id: string): LiveRow {
    let row = this.live.get(id)
    if (!row) this.live.set(id, (row = { info: null, parts: new Map(), due: false, sent: false }))
    return row
  }

  private liveMessage(info: KortixMessageInfo | undefined): void {
    if (typeof info?.id !== 'string' || typeof info.sessionID !== 'string' || this.collected(info.id)) return
    const row = this.row(info.id)
    row.due ||= row.info === null
    row.info = info
    if (row.due) this.publishLive()
  }

  private livePart(part: (KortixPart & Record<string, unknown>) | undefined): void {
    if (typeof part?.id !== 'string' || typeof part.messageID !== 'string' || this.collected(part.messageID)) return
    const row = this.row(part.messageID)
    const before = row.parts.get(part.id)
    // OpenCode also streams complete text snapshots via message.part.updated.
    // Publish changed snapshots; a snapshot echoing an applied delta is unchanged.
    row.due ||= !before || before.text !== part.text || toolShape(before) !== toolShape(part)
    // A copy: deltas extend it, and the v1 ring must keep the frame as published.
    row.parts.set(part.id, structuredClone(part))
    if (row.due) this.publishLive()
  }

  /** A live message the harness removed before the journal collected it (a retracted prompt, a revert): its tombstone, if a put went out. */
  private liveRemoved(id: unknown): void {
    const row = typeof id === 'string' ? this.live.get(id) : undefined
    if (!row) return
    this.live.delete(id as string)
    if (row.sent) sessionLogEventBus().publish('log.message', { message_id: id as string, rev: nextRev() } satisfies SessionLogMessageEvent, row.info?.sessionID)
  }

  private livePartRemoved(messageId: unknown, partId: unknown): void {
    const row = typeof messageId === 'string' ? this.live.get(messageId) : undefined
    if (!row || typeof partId !== 'string' || !row.parts.delete(partId)) return
    row.due = true
    this.publishLive()
  }

  /** A put of each due message whose seq the adapter knows, in the order the v1 bus named them. */
  private publishLive(): void {
    for (const [id, row] of this.live) {
      if (!row.due || !row.info) continue
      const thread = row.info.sessionID
      try {
        const known = this.port.live(thread, id)
        if (!known) continue
        row.due = false
        const harness = this.port.capabilities.harness as FromV1Options['harness']
        const message = this.shifted(liveMessageFromV1({ info: row.info, parts: [...row.parts.values()] }, known, harness))
        row.sent = true
        sessionLogEventBus().publish('log.message', { rev: nextRev(), message } satisfies SessionLogMessageEvent, thread)
      } catch (err) {
        logger.warn('[session-log] live put failed', { message_id: id, err: String(err) })
      }
    }
  }

  private async collectOnce(): Promise<void> {
    const changes = await this.port.changes([...this.cursors.values()])
    await this.storeBlobs(changes.messages.filter(({ message: m, native_hash }) => this.cursors.get(m.thread_id)?.native_hashes[m.message_id] !== native_hash).map((m) => m.message))
    const messages: SessionLogMessageEvent[] = []
    const threads: SessionLogThreadUpsert[] = []
    for (const { message, native_hash } of changes.messages) {
      const id = message.message_id
      let cursor = this.cursors.get(message.thread_id)
      if (!cursor) this.cursors.set(message.thread_id, (cursor = { thread_id: message.thread_id, last_seq: -1, native_hashes: {} }))
      if (cursor.native_hashes[id] === native_hash) continue
      // An attachment not stored yet: '' makes the next collection export the message again.
      cursor.native_hashes[id] = this.withStoredRefs(message) ? native_hash : ''
      cursor.last_seq = Math.max(cursor.last_seq, message.seq)
      this.tombstoned.delete(id)
      const entry = { id, rev: nextRev(), message: this.shifted(message) }
      this.dirty.set(id, entry)
      this.live.delete(id)
      messages.push({ rev: entry.rev, message: entry.message })
    }
    for (const id of changes.tombstones) {
      if (this.tombstoned.has(id)) continue
      this.tombstoned.add(id)
      for (const cursor of this.cursors.values()) delete cursor.native_hashes[id]
      const entry = { id, rev: nextRev() }
      this.dirty.set(id, entry)
      messages.push({ message_id: id, rev: entry.rev })
    }
    for (const thread of changes.threads) {
      const json = JSON.stringify(thread)
      if (this.threadJson.get(thread.thread_id) === json) continue
      this.threadJson.set(thread.thread_id, json)
      this.threads.set(thread.thread_id, thread)
      threads.push(thread)
    }
    if (changes.session) {
      const session = { ...changes.session, ...this.options.session }
      if (changes.session.harness) session.harness = carryHarness(this.options.harness, changes.session.harness)
      this.session = { ...this.session, ...session }
      sessionLogEventBus().publish('log.state', { generation: this.options.generation, session } satisfies SessionLogStateEvent)
    }
    for (const thread of threads) sessionLogEventBus().publish('log.thread', thread, thread.thread_id)
    for (const event of messages) sessionLogEventBus().publish('log.message', event, 'message' in event ? event.message.thread_id : undefined)
  }

  /**
   * Starts a pass over the `blob:` attachments of `messages` this boot has not settled, unless one
   * runs, and waits for it at most `JOURNAL_BLOB_BUDGET_MS` (see the header).
   */
  private async storeBlobs(messages: SessionLogMessage[]): Promise<void> {
    const pending = new Map<string, string>()
    for (const a of messages.flatMap(attachmentsOf)) if (a.ref?.startsWith('blob:') && !this.blobRefs.has(a.ref.slice(5))) pending.set(a.ref.slice(5), a.mime)
    if (pending.size > 0 && !this.blobPass) {
      this.blobPass = this.runBlobPass([...pending])
        .catch((err) => logger.warn('[session-log] attachment pass failed', { err: String(err) }))
        .finally(() => {
          this.blobPass = null
        })
    }
    if (!this.blobPass) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.blobPass, new Promise((resolve) => (timer = setTimeout(resolve, this.options.blobBudgetMs ?? JOURNAL_BLOB_BUDGET_MS)))])
    clearTimeout(timer)
  }

  /** Puts each settled ref on `message`. False when an attachment is not settled yet. */
  private withStoredRefs(message: SessionLogMessage): boolean {
    let settled = true
    for (const a of attachmentsOf(message)) {
      if (!a.ref?.startsWith('blob:')) continue
      const ref = this.blobRefs.get(a.ref.slice(5))
      if (ref === undefined) settled = false
      else if (ref) a.ref = ref
    }
    return settled
  }

  /** Lookups 4 at a time, then the uploads one at a time (the API takes one per session). */
  private async runBlobPass(pending: Array<[sha256: string, mime: string]>): Promise<void> {
    const ctx = sandboxRelayContext()
    if (this.dumpDir || !ctx) {
      for (const [sha256] of pending) this.blobRefs.set(sha256, '')
      return
    }
    if (sessionTokenPresumedDead()) return
    const blobUrl = (sha256: string) => `${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId)}/log/blobs/${sha256}`
    const headers = { Authorization: `Bearer ${ctx.token}` }
    let down = false
    const found = await mapLimit(pending, JOURNAL_BLOB_CONCURRENCY, async ([sha256]) => {
      if (down) return 'down'
      const outcome = await this.lookupBlob(blobUrl(sha256), headers, sha256)
      if (outcome === 'down') down = true
      return outcome
    })
    if (down) return
    const failed: string[] = []
    for (const [sha256, mime] of pending.filter((_, i) => found[i] === 'missing')) {
      const outcome = await this.uploadBlob(blobUrl(sha256), headers, sha256, mime)
      if (outcome === 'down' || (outcome === 'failed' && failed.push(sha256) >= 2)) break
    }
    // One failed upload in a pass is that sha256's. Two are an outage of Storage or the API: none is counted.
    if (failed.length === 1) this.uploadFailed(failed[0]!)
  }

  /** 'settled' (in `blobRefs`), 'missing' (the API has no object) or 'down' (the API cannot answer now). */
  private async lookupBlob(url: string, headers: Record<string, string>, sha256: string): Promise<'settled' | 'missing' | 'down'> {
    let found: Response
    try {
      found = await fetch(url, { headers, signal: AbortSignal.timeout(JOURNAL_POST_TIMEOUT_MS) })
    } catch (err) {
      logger.warn('[session-log] attachment lookup failed; it keeps blob: until a later collection', { err: (err as Error).message })
      return 'down'
    }
    if (found.status === 404) return this.settleBlob(sha256, '')
    if (!found.ok) {
      await this.unhealthy(found, 'lookup')
      return 'down'
    }
    const known = await refOf(found)
    return typeof known === 'string' ? this.settleBlob(sha256, known) : 'missing'
  }

  /** 'settled', 'failed' (counts against the sha256, see `runBlobPass`) or 'down' (busy or refused: counts nothing). */
  private async uploadBlob(url: string, headers: Record<string, string>, sha256: string, mime: string): Promise<'settled' | 'failed' | 'down'> {
    const bytes = this.port.blob?.(sha256)
    if (!bytes || bytes.byteLength > JOURNAL_MAX_BLOB_BYTES) return this.settleBlob(sha256, '')
    let put: Response
    try {
      put = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': mime }, body: bytes, signal: AbortSignal.timeout(JOURNAL_BLOB_TIMEOUT_MS) })
    } catch (err) {
      logger.warn('[session-log] attachment upload failed', { err: (err as Error).message })
      return 'failed'
    }
    const ref = put.ok ? await refOf(put) : undefined
    if (typeof ref === 'string') return this.settleBlob(sha256, ref)
    if (put.status === 400 || put.status === 404 || put.status === 413) return this.settleBlob(sha256, '')
    await this.unhealthy(put, 'upload')
    return put.status === 429 || put.status === 401 ? 'down' : 'failed'
  }

  private settleBlob(sha256: string, ref: string): 'settled' {
    this.blobRefs.set(sha256, ref)
    return 'settled'
  }

  private async unhealthy(r: Response, what: string): Promise<void> {
    noteControlPlaneResponse(r.status, await r.text().catch(() => ''))
    logger.warn(`[session-log] attachment ${what} failed; it keeps blob: until a later collection`, { status: r.status })
  }

  private uploadFailed(sha256: string): void {
    const n = (this.blobFailures.get(sha256) ?? 0) + 1
    this.blobFailures.set(sha256, n)
    if (n < JOURNAL_BLOB_ATTEMPTS) return
    this.blobRefs.set(sha256, '')
    logger.warn('[session-log] attachment upload failed 3 times; it keeps blob: for this boot', { sha256 })
  }

  private drain(): Promise<void> {
    this.draining ??= (async () => {
      while (!this.off && !this.stopped && !this.clean) {
        for (const batch of this.pack()) {
          const sent = await this.send(batch)
          if (sent === 'retry') {
            this.release()
            await this.sleep()
            break
          }
          if (sent === 'repack' || this.off || this.stopped) break
        }
      }
    })().finally(() => {
      this.draining = null
      this.release()
    })
    return this.draining
  }

  private release(): void {
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  /**
   * The dirty set, in order, as gzipped bodies of at most `maxBatch` (8x that raw). Threads and the session patch
   * ride in the first. One message over 2x / 16x (the route's cap at the default) is cut to fit (see the header).
   */
  private pack(): Batch[] {
    const max = this.maxBatch
    const encode = (entries: Entry[], threads: SessionLogThreadUpsert[], session: SessionLogSessionPatch | null) => {
      const request: SessionLogJournalRequest = {
        generation: this.options.generation,
        puts: entries.flatMap((e) => (e.message ? [{ rev: e.rev, message: e.message }] : [])),
        tombstones: entries.flatMap((e) => (e.message ? [] : [{ message_id: e.id, rev: e.rev }])),
        threads,
        ...(session ? { session } : {}),
      }
      const raw = Buffer.from(JSON.stringify(request))
      return { raw: raw.byteLength, body: Bun.gzipSync(raw) }
    }
    const split = (entries: Entry[], threads: SessionLogThreadUpsert[], session: SessionLogSessionPatch | null): Batch[] => {
      let { raw, body } = encode(entries, threads, session)
      if ((body.byteLength <= max && raw <= max * 8) || entries.length <= 1) {
        const [only] = entries
        if (only?.message && (body.byteLength > max * 2 || raw > max * 16)) {
          only.message = cutToFit(only.message, (m) => {
            ;({ raw, body } = encode([{ ...only, message: m }], threads, session))
            return body.byteLength <= max * 2 && raw <= max * 16
          })
          logger.warn('[session-log] one message exceeds the route cap; its longest strings were cut', { message_id: only.id, bytes: body.byteLength, raw })
        }
        return [{ entries, threads, session, body }]
      }
      const half = Math.ceil(entries.length / 2)
      return [...split(entries.slice(0, half), threads, session), ...split(entries.slice(half), [], null)]
    }
    return split([...this.dirty.values()], [...this.threads.values()], this.session)
  }

  /** One POST. */
  private async send(batch: Batch): Promise<Sent> {
    if (this.dumpDir) return this.dump(batch, this.dumpDir)
    const ctx = sandboxRelayContext()
    if (!ctx) {
      this.off = 'no control plane'
      return 'settled'
    }
    // A credential the API refused, repeatedly, cannot land a batch (KRTX-446).
    if (sessionTokenPresumedDead()) return 'retry'
    let response: Response
    this.inflight = new AbortController()
    try {
      response = await fetch(
        `${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId)}/log/journal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${ctx.token}` },
          body: batch.body,
          signal: AbortSignal.any([this.inflight.signal, AbortSignal.timeout(JOURNAL_POST_TIMEOUT_MS)]),
        },
      )
    } catch (err) {
      if (!this.stopped) logger.warn('[session-log] journal post failed', { err: (err as Error).message })
      return 'retry'
    } finally {
      this.inflight = null
    }
    const text = await response.text().catch(() => '')
    if (response.ok) {
      const acked = SessionLogJournalResponseSchema.safeParse(parseJson(text)).data?.acked ?? []
      for (const { message_id, rev } of acked) if (this.dirty.get(message_id)?.rev === rev) this.dirty.delete(message_id)
      const unacked = batch.entries.filter((e) => this.dirty.get(e.id) === e)
      if (unacked.length === 0) {
        this.settle(batch)
        this.failures = 0
        this.unacked = 0
        return 'settled'
      }
      // Threads and the session patch stay dirty: nothing confirmed them.
      this.unacked += 1
      if (this.unacked < JOURNAL_UNACKED_RETRIES) {
        logger.warn('[session-log] journal answered 200 without acknowledging the batch', { unacked: unacked.length, acked: acked.length })
        return 'retry'
      }
      logger.warn('[session-log] journal never acknowledged these pairs; dropping them', { pairs: unacked.map((e) => `${e.id}@${e.rev}`).slice(0, 20) })
      for (const e of unacked) this.dirty.delete(e.id)
      this.unacked = 0
      return 'settled'
    }
    noteControlPlaneResponse(response.status, text)
    if (response.status === 404 || response.status === 409) {
      this.off = String(response.status)
      const current = response.status === 409 ? SessionLogJournalConflictSchema.safeParse(parseJson(text)).data?.generation : undefined
      logger.warn('[session-log] journal off for this boot', { status: response.status, generation: this.options.generation, current })
      return 'settled'
    }
    if (response.status === 422) return this.resequence(text)
    if (response.status === 413 && this.maxBatch > JOURNAL_MIN_BATCH_BYTES) {
      this.maxBatch = Math.max(JOURNAL_MIN_BATCH_BYTES, Math.floor(this.maxBatch / 2))
      logger.warn('[session-log] journal body too large; halving the batch limit', { bytes: batch.body.byteLength, limit: this.maxBatch })
      return 'repack'
    }
    if (response.status === 400) return this.dropInvalid(batch, text)
    logger.warn('[session-log] journal post non-ok; backing off', { status: response.status, body: text.slice(0, 200) })
    return 'retry'
  }

  /** A 422 `seq_conflict`: the thread numbers above `seq_max`, and its messages are collected again (see the header). */
  private async resequence(text: string): Promise<Sent> {
    const conflict = SessionLogJournalSeqConflictSchema.safeParse(parseJson(text)).data
    const before = conflict ? (this.seqOffsets.get(conflict.thread_id) ?? 0) : 0
    if (!conflict || conflict.seq_max + 1 <= before) {
      logger.warn('[session-log] journal seq conflict without a higher seq_max; backing off', { body: text.slice(0, 200) })
      return 'retry'
    }
    const thread = conflict.thread_id
    const offset = conflict.seq_max + 1
    this.seqOffsets.set(thread, offset)
    saveSeqOffsets(Object.fromEntries(this.seqOffsets))
    logger.warn('[session-log] journal seq conflict; the thread now numbers above the log', { thread_id: thread, message_id: conflict.message_id, seq: conflict.seq, seq_max: conflict.seq_max, offset })
    // Every message of the thread goes again at its new seq, also one the API took at its old seq.
    this.cursors.delete(thread)
    for (const [id, e] of this.dirty) if (e.message?.thread_id === thread) this.dirty.delete(id)
    await this.collect()
    return 'repack'
  }

  /** A 400: drop what the zod `issues` name and send the rest; a 400 that names nothing drops the batch. */
  private dropInvalid(batch: Batch, text: string): Sent {
    const issues = ((parseJson(text) as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues ?? []).filter((i) => Array.isArray(i.path))
    const puts = batch.entries.filter((e) => e.message)
    const tombstones = batch.entries.filter((e) => !e.message)
    let dropped = 0
    for (const { path, message } of issues) {
      const [list, index] = path as [unknown, unknown]
      const issue = `${path!.join('.')}: ${message}`
      const entry = list === 'puts' ? puts[index as number] : list === 'tombstones' ? tombstones[index as number] : undefined
      if (entry && this.dirty.get(entry.id) === entry) {
        this.dirty.delete(entry.id)
        dropped++
        const m = entry.message
        logger.error('[session-log] journal refused a record; dropped it', { issue, message_id: entry.id, rev: entry.rev, thread_id: m?.thread_id, seq: m?.seq, role: m?.role, kind: m?.kind, record: m ? JSON.stringify(m).slice(0, 2_000) : null })
      }
      const t = list === 'threads' ? batch.threads[index as number] : undefined
      if (t && this.threads.get(t.thread_id) === t) {
        this.threads.delete(t.thread_id)
        dropped++
        logger.error('[session-log] journal refused a thread; dropped it', { issue, thread: JSON.stringify(t).slice(0, 2_000) })
      }
      if (list === 'session' && batch.session && this.session === batch.session) {
        this.session = null
        dropped++
        logger.error('[session-log] journal refused the session patch; dropped it', { issue, session: JSON.stringify(batch.session).slice(0, 2_000) })
      }
    }
    if (dropped > 0) return 'repack'
    logger.error('[session-log] journal rejected a batch it cannot split; dropping it', { status: 400, body: text.slice(0, 200) })
    for (const e of batch.entries) if (this.dirty.get(e.id) === e) this.dirty.delete(e.id)
    this.settle(batch)
    return 'settled'
  }

  /** Debug sink (`KORTIX_SESSION_LOG_DUMP_DIR`): the batch body as JSON in `dir`, acknowledged at once. Nothing is posted. */
  private dump(batch: Batch, dir: string): Sent {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, `batch-${Date.now()}-${++this.dumped}.json`), new TextDecoder().decode(Bun.gunzipSync(batch.body)), { mode: 0o600 })
    } catch (err) {
      logger.warn('[session-log] journal dump failed', { dir, err: (err as Error).message })
      return 'retry'
    }
    for (const e of batch.entries) if (this.dirty.get(e.id) === e) this.dirty.delete(e.id)
    this.settle(batch)
    return 'settled'
  }

  /** Threads and the session patch of a settled batch, unless they changed since. */
  private settle(batch: Batch): void {
    for (const thread of batch.threads) if (this.threads.get(thread.thread_id) === thread) this.threads.delete(thread.thread_id)
    if (batch.session && this.session === batch.session) this.session = null
  }

  private sleep(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.failures += 1
    const ms = computeRetryDelay({
      retryMs: this.options.retryMs ?? 1_000,
      maxRetryMs: this.options.maxRetryMs ?? MAX_RETRY_MS_DEFAULT,
      failures: this.failures,
      jitter: Math.random(),
      serverRetryAfterMs: null,
    })
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wakeBackoff?.(), ms)
      this.wakeBackoff = () => {
        clearTimeout(timer)
        this.wakeBackoff = null
        resolve()
      }
    })
  }
}

/**
 * `SessionLogPort.changes` for an adapter that rebuilds its whole log on each read (pi,
 * OpenCode): every message after its thread's cursor or with a new native hash, every id a
 * cursor holds that the log no longer has (a tombstone), every thread (the journal drops an
 * unchanged one), and the session fields when their JSON differs from `previousSessionJson`.
 */
export function logChanges(
  log: SessionLog,
  hashes: ReadonlyMap<string, string>,
  cursors: readonly ExportCursor[],
  previousSessionJson: string | null,
): { changes: SessionLogChanges; sessionJson: string } {
  const byThread = new Map(cursors.map((c) => [c.thread_id, c]))
  const messages: ExportedMessage[] = []
  for (const thread of log.threads) {
    const cursor = byThread.get(thread.thread_id)
    for (const message of thread.messages) {
      const native_hash = hashes.get(message.message_id)!
      if (!cursor || message.seq > cursor.last_seq || cursor.native_hashes[message.message_id] !== native_hash) messages.push({ message, native_hash })
    }
  }
  const tombstones = cursors.flatMap((c) => Object.keys(c.native_hashes).filter((id) => !hashes.has(id)))
  const { threads, ...session } = log
  const sessionJson = JSON.stringify(session)
  return {
    changes: {
      messages,
      tombstones,
      threads: threads.map(({ messages: _messages, ...thread }) => thread),
      ...(sessionJson !== previousSessionJson ? { session } : {}),
    },
    sessionJson,
  }
}

/**
 * What a live put shows of a tool part that its later updates change: the status and the
 * metadata keys (task `sessionId`, bash `command`), not their values. ponytail: bash rewrites
 * `metadata.output` per stdout chunk and a put rebuilds the whole message, so a growing output
 * or a streaming `raw` waits for the next put; key on values when a throttled put lands.
 */
function toolShape(part: Record<string, any>): string {
  if (part.type !== 'tool') return ''
  const meta = part.state?.metadata ?? {}
  // The keys the wire carries: pi's bash ends with `truncation: undefined`, which JSON drops.
  const keys = Object.keys(meta).filter((k) => meta[k] !== undefined).join()
  // A codemode script's calls (pi `details.calls`): a put per call start and end, at most 2 per call.
  const calls = Array.isArray(meta.calls) ? `:${meta.calls.map((c: { status?: unknown }) => String(c?.status)).join()}` : ''
  return `${part.state?.status}:${keys}${calls}`
}

/**
 * A copy of `message` whose longest strings, longest first, keep their first 16 kB and `JOURNAL_TRUNCATION_MARK`,
 * until `fits` holds. ponytail: a message of many strings under 16 kB stays over the cap and the 413 halving
 * backs off at 64 kB; upload the long strings as blobs (the F3 `ref`) if one ever shows up.
 */
function cutToFit(message: SessionLogMessage, fits: (m: SessionLogMessage) => boolean): SessionLogMessage {
  const copy = structuredClone(message)
  const long: Array<{ holder: Record<string, unknown>; key: string; length: number }> = []
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return
    for (const [key, child] of Object.entries(v)) {
      if (typeof child === 'string' && child.length > JOURNAL_CUT_CHARS) long.push({ holder: v as Record<string, unknown>, key, length: child.length })
      else walk(child)
    }
  }
  walk(copy.blocks)
  for (const { holder, key, length } of long.sort((a, b) => b.length - a.length)) {
    holder[key] = `${(holder[key] as string).slice(0, JOURNAL_CUT_CHARS)}\n\n${JOURNAL_TRUNCATION_MARK} (${length} characters)`
    if (fits(copy)) break
  }
  return copy
}

const refOf = async (r: Response) => ((await r.json().catch(() => null)) as { ref?: unknown } | null)?.ref

/** Every attachment of a message: its attachment blocks and its tool results' attachment items. */
function attachmentsOf(message: SessionLogMessage): Array<{ ref?: string; mime: string }> {
  return message.blocks.flatMap((b) =>
    b.type === 'attachment' ? [b] : b.type === 'tool_call' ? [...(b.result?.content ?? []), ...(b.result?.model_content ?? [])].filter((c) => c.type === 'attachment') : [],
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ── The boot's journal ────────────────────────────────────────────────────

let active: SessionLogJournal | null = null

/** Start this boot's journal. An adapter calls it once its native store is ready (after a restore, with its cursors). */
export function startSessionLogJournal(port: SessionLogPort, options: SessionLogJournalOptions): SessionLogJournal | null {
  if (!sandboxRelayContext()) return null
  // One journal per boot: a second start replaces the first, which sends nothing more.
  void active?.stop(0)
  active = new SessionLogJournal(port, options)
  // The store is at rest now: the v2 stream gets the session and its threads before the first turn streams.
  void active.collect()
  return active
}

/** Before a turn's end is relayed. True when there is nothing left to acknowledge. */
export function flushSessionLogJournal(): Promise<boolean> {
  return active ? active.flush() : Promise.resolve(true)
}

/** Every daemon stop path, before the harness stops. */
export async function stopSessionLogJournal(): Promise<void> {
  await active?.stop()
}

/** Test seam. */
export function resetSessionLogJournalForTests(): void {
  void active?.stop(0)
  active = null
}
