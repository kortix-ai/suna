/**
 * Read-only reader for OpenCode's own SQLite store.
 *
 * WHY THIS EXISTS. The Kortix Runtime API (`/kortix/opencode/*`) answers
 * transcript and session reads from OpenCode's storage instead of proxying
 * OpenCode's HTTP. Measured on box `ib31dg1elkycjulm0eeq1` (154 messages /
 * 573 parts / 1.60 MB of transcript JSON, WS-V, 2026-08-26):
 *
 *   | operation                                     | median |
 *   |-----------------------------------------------|--------|
 *   | SQLite -> assemble full transcript -> stringify| 9.9 ms |
 *   | SQLite -> last-50-message page                 | 2.4 ms |
 *   | opencode `GET /session/{id}/message` (full)    | 19.2 ms|
 *   | opencode `GET .../message?limit=50`            |  8.1 ms|
 *
 * The CPU saving (9 ms) is not the point. The point is that a SQLite read is
 * answerable while OpenCode is mid-turn, wedged, or dead — the exact windows
 * in which the product most needs to paint a transcript — and that it can be
 * projected before a byte leaves the box.
 *
 * SCHEMA (dumped live off a 1.18.23 box; see `WS-V` §2.2). `message.data` and
 * `part.data` hold the whole envelope as JSON; the columns beside them are the
 * index keys:
 *
 *   session(id, project_id, title, directory, time_created, time_updated, …)
 *   message(id, session_id, time_created, time_updated, data)
 *   part(id, message_id, session_id, time_created, time_updated, data)
 *   event(id, aggregate_id, seq, type, data)
 *   event_sequence(aggregate_id, seq, owner_id)
 *   INDEX message_session_time_created_id_idx ON message(session_id,time_created,id)
 *   INDEX part_message_id_id_idx              ON part(message_id,id)
 *
 * SAFETY RULES, each one load-bearing:
 *
 *  - **Read-only, always.** `SQLITE_OPEN_READONLY` plus `PRAGMA query_only`.
 *    The offload pass (attachment-offload.ts) is the ONLY writer this daemon
 *    owns, and it is deliberately a separate connection with its own rules.
 *  - **WAL-safe.** OpenCode holds the database open in WAL mode and writes
 *    while we read. A reader in WAL never blocks a writer and never sees a
 *    torn page; `busy_timeout` covers the one case that can still block (a
 *    checkpoint taking the exclusive lock) and a `SQLITE_BUSY` past that is
 *    reported, never papered over.
 *  - **Never serve a partial row.** Every multi-statement read (a message page
 *    plus its parts) runs inside ONE deferred transaction, so it sees a single
 *    consistent WAL snapshot: a message can never come back with the parts of
 *    a later write. A row whose JSON does not parse is DROPPED with a count,
 *    never emitted half-decoded.
 *  - **Shape-gated.** `probe()` verifies the tables and columns this reader
 *    depends on before any read is served. A DB that does not match answers
 *    `supported: false`, and the caller falls back to OpenCode's HTTP. A schema
 *    change in a future OpenCode therefore degrades to "slower", never "wrong".
 */
import { Database } from 'bun:sqlite'
import { logger } from './logger'

/** Tiny retry for `SQLITE_BUSY` past `busy_timeout` — a checkpoint window. */
export const DB_BUSY_RETRIES = 3
export const DB_BUSY_RETRY_DELAY_MS = 15
export const DB_BUSY_TIMEOUT_MS = 2_000

/**
 * OpenCode minor lines whose storage shape this reader is verified against.
 *
 * Duplicated, not imported: this daemon ships inside the sandbox image and
 * cannot import from the monorepo (same constraint `proxy.ts` documents for
 * `isBlockingTurnRequest`). `opencode-db.versions.test.ts` asserts the pin in
 * `packages/shared/src/runtime-versions.json` is still covered here, so a bump
 * that outruns this list fails a test instead of a production read.
 */
export const SQLITE_READER_SUPPORTED_MINORS = ['1.18'] as const

export function isSupportedOpencodeVersion(version: string | null | undefined): boolean {
  if (!version) return false
  const m = /^(\d+)\.(\d+)\./.exec(version.trim())
  if (!m) return false
  return (SQLITE_READER_SUPPORTED_MINORS as readonly string[]).includes(`${m[1]}.${m[2]}`)
}

export interface SessionRow {
  id: string
  title: string
  directory: string
  parent_id: string | null
  time_created: number
  time_updated: number
  time_compacting: number | null
  time_archived: number | null
  revert: string | null
  agent: string | null
  model: string | null
}

export interface MessageRow {
  id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export interface PartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

export interface EventRow {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: string
}

export interface MessagePage {
  /** Newest-last, ordered by `(time_created, id)` exactly as OpenCode orders. */
  messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  /** Rows dropped because their JSON did not parse. Always reported. */
  dropped: number
  /** True when more rows exist beyond the page in the requested direction. */
  hasMore: boolean
}

export type MessagePageQuery = {
  sessionId: string
  limit: number
  /** Exclusive lower bound — message id. Mutually exclusive with `before`. */
  after?: string | null
  /** Exclusive upper bound — message id. Serves `loadOlder`. */
  before?: string | null
  /** Only messages touched by an event with `seq > afterSeq`. */
  afterSeq?: number | null
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  session: ['id', 'title', 'directory', 'time_created', 'time_updated'],
  message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
  event: ['id', 'aggregate_id', 'seq', 'type', 'data'],
  event_sequence: ['aggregate_id', 'seq'],
}

function isBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

function parseJsonRow(data: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export interface OpencodeDbProbe {
  supported: boolean
  /** Why not, when `supported` is false — logged once, surfaced in `/kortix/diag`. */
  reason: string | null
  tables: string[]
}

/**
 * A lazily-opened, read-only handle on `opencode.db`.
 *
 * One instance per daemon. The connection is opened on first use and kept: the
 * open costs ~0.3 ms but the page cache it warms is what makes a repeat
 * transcript read 2 ms instead of 10.
 */
export class OpencodeDb {
  private db: Database | null = null
  private probed: OpencodeDbProbe | null = null

  constructor(private readonly path: string) {}

  /** The file this reader is bound to. */
  get dbPath(): string {
    return this.path
  }

  private connection(): Database {
    if (this.db) return this.db
    const db = new Database(this.path, { readonly: true })
    // `query_only` is belt to `readonly`'s braces: it also refuses a write
    // issued through a statement this class did not author (a future
    // contributor's `db.exec`), which the open flag alone would allow to
    // compile before failing at run time.
    db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA query_only = 1')
    this.db = db
    return db
  }

  /**
   * Verify the schema this reader depends on. Cached — the shape cannot change
   * without OpenCode restarting, which restarts this daemon's view too.
   */
  probe(): OpencodeDbProbe {
    if (this.probed) return this.probed
    try {
      const db = this.connection()
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
      for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        if (!tables.includes(table)) {
          this.probed = { supported: false, reason: `missing table ${table}`, tables }
          return this.probed
        }
        const present = new Set(
          db
            .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
            .all()
            .map((r) => r.name),
        )
        for (const column of columns) {
          if (!present.has(column)) {
            this.probed = { supported: false, reason: `missing ${table}.${column}`, tables }
            return this.probed
          }
        }
      }
      this.probed = { supported: true, reason: null, tables }
    } catch (err) {
      this.probed = {
        supported: false,
        reason: (err as Error).message,
        tables: [],
      }
      logger.warn('[opencode-db] probe failed', { path: this.path, err: (err as Error).message })
    }
    return this.probed
  }

  /** Run `fn` with a tiny busy retry. Returns `null` when every attempt is busy. */
  private retry<T>(label: string, fn: (db: Database) => T): T | null {
    for (let attempt = 0; attempt <= DB_BUSY_RETRIES; attempt++) {
      try {
        return fn(this.connection())
      } catch (err) {
        if (isBusy(err) && attempt < DB_BUSY_RETRIES) {
          Bun.sleepSync(DB_BUSY_RETRY_DELAY_MS)
          continue
        }
        logger.warn('[opencode-db] read failed', {
          label,
          path: this.path,
          err: (err as Error).message,
        })
        return null
      }
    }
    return null
  }

  /** Every session row, newest-updated first. `null` when the DB is unreadable. */
  sessions(limit = 200): SessionRow[] | null {
    return this.retry('sessions', (db) =>
      db
        .query<SessionRow, [number]>(
          `SELECT id, title, directory, parent_id, time_created, time_updated,
                  time_compacting, time_archived, revert, agent, model
             FROM session
            ORDER BY time_updated DESC
            LIMIT ?`,
        )
        .all(limit),
    )
  }

  session(id: string): SessionRow | null {
    const row = this.retry('session', (db) =>
      db
        .query<SessionRow, [string]>(
          `SELECT id, title, directory, parent_id, time_created, time_updated,
                  time_compacting, time_archived, revert, agent, model
             FROM session WHERE id = ?`,
        )
        .get(id),
    )
    return row ?? null
  }

  /** OpenCode's own durable event cursor, per aggregate (= per OpenCode session). */
  headSeqs(): Record<string, number> | null {
    const rows = this.retry('headSeqs', (db) =>
      db
        .query<{ aggregate_id: string; seq: number }, []>(
          'SELECT aggregate_id, seq FROM event_sequence',
        )
        .all(),
    )
    if (!rows) return null
    const out: Record<string, number> = {}
    for (const row of rows) out[row.aggregate_id] = row.seq
    return out
  }

  headSeq(aggregateId: string): number | null {
    const row = this.retry('headSeq', (db) =>
      db
        .query<{ seq: number }, [string]>(
          'SELECT seq FROM event_sequence WHERE aggregate_id = ?',
        )
        .get(aggregateId),
    )
    return row?.seq ?? null
  }

  /** Durable events for one aggregate above `seq`, ascending. */
  eventsAfter(aggregateId: string, seq: number, limit = 500): EventRow[] | null {
    return this.retry('eventsAfter', (db) =>
      db
        .query<EventRow, [string, number, number]>(
          `SELECT id, aggregate_id, seq, type, data
             FROM event
            WHERE aggregate_id = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT ?`,
        )
        .all(aggregateId, seq, limit),
    )
  }

  /**
   * One consistent page of messages with their parts.
   *
   * The whole read is one deferred transaction: SQLite gives it a single WAL
   * snapshot, so the parts are always the parts OF the messages returned, even
   * when OpenCode commits a step in the middle.
   */
  messagePage(query: MessagePageQuery): MessagePage | null {
    const limit = Math.max(1, Math.min(query.limit, 500))
    return this.retry('messagePage', (db) => {
      const read = db.transaction((): MessagePage => {
        let rows: MessageRow[]
        let hasMore = false
        if (query.afterSeq != null) {
          // Delta refresh: the messages OpenCode's own durable log says
          // changed since the caller's cursor. `message.updated.*` names the
          // message; `message.part.updated.*` names it through the part.
          const events = db
            .query<{ data: string }, [string, number]>(
              `SELECT data FROM event
                WHERE aggregate_id = ? AND seq > ?
                  AND (type LIKE 'message.updated%' OR type LIKE 'message.part.updated%')
                ORDER BY seq ASC`,
            )
            .all(query.sessionId, query.afterSeq)
          const ids = new Set<string>()
          for (const event of events) {
            const parsed = parseJsonRow(event.data)
            if (!parsed) continue
            const info = parsed.info as { id?: unknown } | undefined
            const part = parsed.part as { messageID?: unknown } | undefined
            if (info && typeof info.id === 'string') ids.add(info.id)
            else if (part && typeof part.messageID === 'string') ids.add(part.messageID)
            else if (typeof parsed.messageID === 'string') ids.add(parsed.messageID)
          }
          if (ids.size === 0) return { messages: [], dropped: 0, hasMore: false }
          const list = [...ids]
          const placeholders = list.map(() => '?').join(',')
          rows = db
            .query<MessageRow, string[]>(
              `SELECT id, session_id, time_created, time_updated, data
                 FROM message
                WHERE session_id = ? AND id IN (${placeholders})
                ORDER BY time_created ASC, id ASC`,
            )
            .all(query.sessionId, ...list)
        } else if (query.before) {
          const anchor = db
            .query<{ time_created: number }, [string]>(
              'SELECT time_created FROM message WHERE id = ?',
            )
            .get(query.before)
          if (!anchor) return { messages: [], dropped: 0, hasMore: false }
          const page = db
            .query<MessageRow, [string, number, number, string, number]>(
              `SELECT id, session_id, time_created, time_updated, data
                 FROM message
                WHERE session_id = ?
                  AND (time_created < ? OR (time_created = ? AND id < ?))
                ORDER BY time_created DESC, id DESC
                LIMIT ?`,
            )
            .all(query.sessionId, anchor.time_created, anchor.time_created, query.before, limit + 1)
          hasMore = page.length > limit
          rows = page.slice(0, limit).reverse()
        } else if (query.after) {
          const anchor = db
            .query<{ time_created: number }, [string]>(
              'SELECT time_created FROM message WHERE id = ?',
            )
            .get(query.after)
          if (!anchor) return { messages: [], dropped: 0, hasMore: false }
          const page = db
            .query<MessageRow, [string, number, number, string, number]>(
              `SELECT id, session_id, time_created, time_updated, data
                 FROM message
                WHERE session_id = ?
                  AND (time_created > ? OR (time_created = ? AND id > ?))
                ORDER BY time_created ASC, id ASC
                LIMIT ?`,
            )
            .all(query.sessionId, anchor.time_created, anchor.time_created, query.after, limit + 1)
          hasMore = page.length > limit
          rows = page.slice(0, limit)
        } else {
          // No cursor: the NEWEST page, which is what a session open paints.
          const page = db
            .query<MessageRow, [string, number]>(
              `SELECT id, session_id, time_created, time_updated, data
                 FROM message
                WHERE session_id = ?
                ORDER BY time_created DESC, id DESC
                LIMIT ?`,
            )
            .all(query.sessionId, limit + 1)
          hasMore = page.length > limit
          rows = page.slice(0, limit).reverse()
        }

        if (rows.length === 0) return { messages: [], dropped: 0, hasMore }

        const placeholders = rows.map(() => '?').join(',')
        const partRows = db
          .query<PartRow, string[]>(
            `SELECT id, message_id, session_id, time_created, time_updated, data
               FROM part
              WHERE message_id IN (${placeholders})
              ORDER BY message_id ASC, id ASC`,
          )
          .all(...rows.map((r) => r.id))

        let dropped = 0
        const partsByMessage = new Map<string, Array<Record<string, unknown>>>()
        for (const row of partRows) {
          const parsed = parseJsonRow(row.data)
          if (!parsed) {
            dropped++
            continue
          }
          const list = partsByMessage.get(row.message_id)
          if (list) list.push(parsed)
          else partsByMessage.set(row.message_id, [parsed])
        }

        const messages: MessagePage['messages'] = []
        for (const row of rows) {
          const info = parseJsonRow(row.data)
          if (!info) {
            // A message whose envelope will not parse cannot be served with
            // its parts attributed correctly, so it is dropped whole. Never
            // emit an `info`-less shell — the SDK reducer keys on `info.id`.
            dropped++
            continue
          }
          messages.push({ info, parts: partsByMessage.get(row.id) ?? [] })
        }
        return { messages, dropped, hasMore }
      })
      return read()
    })
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // Nothing to do — the process is going away or the handle is already shut.
    }
    this.db = null
  }
}
