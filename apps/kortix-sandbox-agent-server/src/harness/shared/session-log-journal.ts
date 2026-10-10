/**
 * The session-log journal: the daemon's push of `kortix.session/2` records to
 * `POST /projects/:p/sessions/:s/log/journal` (wire: `@kortix/api-contract/session-log`).
 *
 * - It pulls changes from the adapter's `SessionLogPort`, drops unchanged
 *   messages by native hash (C13), and keeps the rest in a dirty set until the
 *   API acknowledges their `(message_id, rev)`.
 * - It posts the dirty set in order, in batches of at most 1 MB gzipped. One
 *   message larger than that goes alone.
 * - `relayTurnEnd` and the daemon shutdown call `flush`, which waits at most
 *   3 s for the acknowledgement. A batch not acknowledged by then keeps
 *   retrying in the background; the v1 capture still saves the turn.
 * - Network errors, 401, 429 and 5xx (503: the operator switch is off) back
 *   off exponentially and keep the dirty set. 404 (an API without the route)
 *   and 409 (a newer generation owns the session: this box is a zombie) turn
 *   the journal off for this boot. Any other 4xx drops the batch: it can never
 *   succeed, and retrying it would block every later message.
 *
 * Same credential and relay context as every other daemon callback
 * (`sandboxRelayContext`); same backoff as the audit relay (`computeRetryDelay`).
 */
import {
  SessionLogJournalConflictSchema,
  SessionLogJournalResponseSchema,
  type ExportCursor,
  type SessionLogJournalRequest,
  type SessionLogMessage,
  type SessionLogSessionPatch,
  type SessionLogThreadUpsert,
} from '@kortix/api-contract/session-log'
import { logger } from '@/lib/log/logger'
import { sandboxRelayContext } from '@/lib/kortix-api/relay-context'
import { noteControlPlaneResponse } from '@/lib/kortix-api/session-token-health'
import type { SessionLogPort } from '../contract/session-log'
import { computeRetryDelay, MAX_RETRY_MS_DEFAULT } from './audit-relay'

export const JOURNAL_MAX_BATCH_BYTES = 1024 * 1024
export const JOURNAL_ACK_TIMEOUT_MS = 3_000

export interface SessionLogJournalOptions {
  /** The session generation this box writes under. */
  generation: number
  /** Cursors `restore` returned; empty on a box that restored nothing. */
  cursors?: readonly ExportCursor[]
  /** Test seams. */
  maxBatchBytes?: number
  retryMs?: number
  maxRetryMs?: number
}

/** A pending revision: a whole message, or a tombstone when `message` is absent. */
type Entry = { id: string; rev: number; message?: SessionLogMessage }
type Batch = { entries: Entry[]; threads: SessionLogThreadUpsert[]; session: SessionLogSessionPatch | null; body: Uint8Array }

export class SessionLogJournal {
  private readonly cursors = new Map<string, ExportCursor>()
  private readonly revs = new Map<string, number>()
  private readonly tombstoned = new Set<string>()
  private readonly dirty = new Map<string, Entry>()
  private readonly threads = new Map<string, SessionLogThreadUpsert>()
  private session: SessionLogSessionPatch | null = null
  private off: string | null = null
  private stopped = false
  private failures = 0
  private draining: Promise<void> | null = null
  private collecting: Promise<void> | null = null
  private recollect = false
  private wakeBackoff: (() => void) | null = null

  constructor(
    private readonly port: SessionLogPort,
    private readonly options: SessionLogJournalOptions,
  ) {
    for (const cursor of options.cursors ?? []) this.cursors.set(cursor.thread_id, structuredClone(cursor))
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
   * Collect the adapter's changes and send them. Resolves within `timeoutMs`:
   * true when everything collected is acknowledged, false otherwise (sending
   * continues in the background).
   */
  async flush(timeoutMs = JOURNAL_ACK_TIMEOUT_MS): Promise<boolean> {
    if (this.off || this.stopped) return false
    const work = this.collect()
      .then(() => this.drain())
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
    this.wakeBackoff?.()
    if (!this.clean && !this.off) logger.warn('[session-log] journal stopped with unacknowledged changes', { pending: this.dirty.size })
  }

  private collect(): Promise<void> {
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

  private async collectOnce(): Promise<void> {
    const changes = await this.port.changes([...this.cursors.values()])
    for (const { message, native_hash } of changes.messages) {
      const id = message.message_id
      let cursor = this.cursors.get(message.thread_id)
      if (!cursor) this.cursors.set(message.thread_id, (cursor = { thread_id: message.thread_id, last_seq: -1, native_hashes: {} }))
      if (cursor.native_hashes[id] === native_hash) continue
      cursor.native_hashes[id] = native_hash
      cursor.last_seq = Math.max(cursor.last_seq, message.seq)
      this.tombstoned.delete(id)
      this.dirty.set(id, { id, rev: this.nextRev(id), message })
    }
    for (const id of changes.tombstones) {
      if (this.tombstoned.has(id)) continue
      this.tombstoned.add(id)
      for (const cursor of this.cursors.values()) delete cursor.native_hashes[id]
      this.dirty.set(id, { id, rev: this.nextRev(id) })
    }
    for (const thread of changes.threads) this.threads.set(thread.thread_id, thread)
    if (changes.session) this.session = { ...this.session, ...changes.session }
  }

  private nextRev(id: string): number {
    const rev = (this.revs.get(id) ?? 0) + 1
    this.revs.set(id, rev)
    return rev
  }

  private drain(): Promise<void> {
    this.draining ??= (async () => {
      while (!this.off && !this.stopped && !this.clean) {
        for (const batch of this.pack()) {
          if (!(await this.send(batch))) {
            await this.sleep()
            break
          }
        }
      }
    })().finally(() => {
      this.draining = null
    })
    return this.draining
  }

  /** The dirty set, in order, as gzipped bodies of at most `maxBatchBytes`. Threads and the session patch ride in the first. */
  private pack(): Batch[] {
    const max = this.options.maxBatchBytes ?? JOURNAL_MAX_BATCH_BYTES
    const split = (entries: Entry[], threads: SessionLogThreadUpsert[], session: SessionLogSessionPatch | null): Batch[] => {
      const request: SessionLogJournalRequest = {
        generation: this.options.generation,
        puts: entries.flatMap((e) => (e.message ? [{ rev: e.rev, message: e.message }] : [])),
        tombstones: entries.flatMap((e) => (e.message ? [] : [{ message_id: e.id, rev: e.rev }])),
        threads,
        ...(session ? { session } : {}),
      }
      const body = Bun.gzipSync(JSON.stringify(request))
      if (body.byteLength <= max || entries.length <= 1) {
        if (body.byteLength > max) logger.warn('[session-log] one message exceeds the batch limit; sent alone', { bytes: body.byteLength })
        return [{ entries, threads, session, body }]
      }
      const half = Math.ceil(entries.length / 2)
      return [...split(entries.slice(0, half), threads, session), ...split(entries.slice(half), [], null)]
    }
    return split([...this.dirty.values()], [...this.threads.values()], this.session)
  }

  /** One POST. True when the batch is settled (acknowledged or dropped); false to back off. */
  private async send(batch: Batch): Promise<boolean> {
    const ctx = sandboxRelayContext()
    if (!ctx) {
      this.off = 'no control plane'
      return true
    }
    let response: Response
    try {
      response = await fetch(
        `${ctx.apiRoot}/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(ctx.sessionId)}/log/journal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${ctx.token}` },
          body: batch.body,
          signal: AbortSignal.timeout(15_000),
        },
      )
    } catch (err) {
      logger.warn('[session-log] journal post failed', { err: (err as Error).message })
      return false
    }
    const text = await response.text().catch(() => '')
    if (response.ok) {
      const acked = SessionLogJournalResponseSchema.safeParse(parseJson(text)).data?.acked ?? []
      for (const { message_id, rev } of acked) if (this.dirty.get(message_id)?.rev === rev) this.dirty.delete(message_id)
      this.settle(batch)
      if (batch.entries.some((e) => this.dirty.get(e.id) === e)) {
        logger.warn('[session-log] journal answered 200 without acknowledging the batch', { entries: batch.entries.length, acked: acked.length })
        return false
      }
      this.failures = 0
      return true
    }
    noteControlPlaneResponse(response.status, text)
    if (response.status === 404 || response.status === 409) {
      this.off = String(response.status)
      const current = response.status === 409 ? SessionLogJournalConflictSchema.safeParse(parseJson(text)).data?.generation : undefined
      logger.warn('[session-log] journal off for this boot', { status: response.status, generation: this.options.generation, current })
      return true
    }
    if (response.status === 401 || response.status === 429 || response.status >= 500) {
      logger.warn('[session-log] journal post non-ok; backing off', { status: response.status, body: text.slice(0, 200) })
      return false
    }
    logger.error('[session-log] journal rejected a batch; dropping it', { status: response.status, body: text.slice(0, 200) })
    for (const e of batch.entries) if (this.dirty.get(e.id) === e) this.dirty.delete(e.id)
    this.settle(batch)
    return true
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
  active = new SessionLogJournal(port, options)
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
