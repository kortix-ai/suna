/**
 * Attachment offload: inline image bytes out of OpenCode's transcript store.
 *
 * WHY. OpenCode keeps every tool screenshot as a base64 `data:` URL inside the
 * tool part's `state.attachments[]`, in the `part` table of `opencode.db`.
 * Measured on Essentia 2026-08-25: one root = 352 tool parts carrying
 * 275 MB of attachments out of a 276 MB transcript. Every consumer re-pays
 * those bytes: each LLM step re-serialises the whole history before our
 * llm-proxy windows it to 12 images, every message-list request serialises
 * it again, and the old reaper probe did that every 10 s. OpenCode reached
 * 6.48 GB RSS on an 8 GB box and the kernel killed it mid-turn.
 *
 * WHAT. When OpenCode is idle, attachments OLDER than the newest
 * `keepNewest` (12 = the llm-proxy image window) per session are moved to
 * sidecar files and the row is rewritten in place:
 *   - bytes → `<sidecarDir>/<attachmentId>` (written + fsynced first);
 *   - `url` → a 1×1 PNG data URL (114 bytes): still a valid image for every
 *     reader — OpenCode's model conversion, the AI SDK, the provider — so no
 *     code path sees a shape it did not expect. The llm-proxy keeps only the
 *     newest 12 images per request, so these placeholders never reach a
 *     model in practice; if compaction ever leaves fewer than 12, a model
 *     sees a blank pixel for a screenshot it would not have seen anyway;
 *   - `kortix: { offloaded: true, sidecar, bytes, mime }` marks it; the
 *     proxy's response stripper turns it into an on-demand ref and
 *     `/kortix/part/:s/:m/:p` serves the sidecar bytes to the UI.
 *
 * Verified live on 1.18.23 (2026-08-25, box i67m4): OpenCode serves an
 * externally UPDATEd row on the next read — no cache, no restart; the UPDATE
 * took 7 ms with OpenCode holding the DB open (WAL).
 *
 * SAFETY.
 *   - Only when no turn is in flight (caller's `turnInFlight()`), and never
 *     the newest message of a session: the row OpenCode may still be writing.
 *   - Optimistic: `UPDATE … WHERE id = ? AND time_updated = ?`; a row OpenCode
 *     touched in between is skipped, not clobbered.
 *   - Sidecar is written and fsynced BEFORE the row changes; a crash between
 *     the two leaves the original bytes in the row and an orphan file.
 *   - Bounded work per pass (`maxPartsPerPass`), one short transaction per
 *     row; `busy_timeout` so OpenCode's own writes win.
 *   - Never throws to the caller; every failure is a counted, logged skip.
 */
import { Database } from 'bun:sqlite'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'

export const OFFLOAD_PLACEHOLDER_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
/** Attachments at or below this size stay inline — the row is not worth a file. */
export const OFFLOAD_MIN_BYTES = 32 * 1024
export const DEFAULT_KEEP_NEWEST = 12
export const DEFAULT_MAX_PARTS_PER_PASS = 200

export interface OffloadedMarker {
  offloaded: true
  sidecar: string
  bytes: number
  mime: string | null
  at: string
}

export interface AttachmentLike {
  id?: string
  type?: string
  mime?: string
  url?: string
  kortix?: OffloadedMarker
  [k: string]: unknown
}

export interface OffloadOptions {
  dbPath: string
  sidecarDir: string
  keepNewest?: number
  maxPartsPerPass?: number
  minBytes?: number
  now?: () => Date
  /** Tests: runs after a row is read and before its UPDATE. */
  beforeUpdate?: (partId: string) => void
}

export interface OffloadResult {
  scanned: number
  offloaded: number
  bytesMoved: number
  skippedBusy: number
  errors: number
  sessions: number
  durationMs: number
}

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s

/** Every inline attachment inside one part's JSON: tool `state.attachments[]` and file parts. */
export function inlineAttachmentsOf(part: Record<string, unknown>): AttachmentLike[] {
  const out: AttachmentLike[] = []
  if (part.type === 'file' && typeof part.url === 'string') out.push(part as AttachmentLike)
  const state = part.state as { attachments?: unknown } | undefined
  if (state && Array.isArray(state.attachments)) {
    for (const a of state.attachments) {
      if (a && typeof a === 'object' && typeof (a as AttachmentLike).url === 'string') out.push(a as AttachmentLike)
    }
  }
  return out
}

export function isOffloadable(a: AttachmentLike, minBytes: number): boolean {
  return (
    typeof a.id === 'string' &&
    typeof a.url === 'string' &&
    a.url.startsWith('data:') &&
    a.url.length > minBytes &&
    !a.kortix?.offloaded
  )
}

export function decodeDataUrl(url: string): { mime: string | null; bytes: Buffer } | null {
  const m = DATA_URL_RE.exec(url)
  if (!m) return null
  const payload = m[3] ?? ''
  return {
    mime: m[1] ?? null,
    bytes: m[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'),
  }
}

export function sidecarPathFor(sidecarDir: string, attachmentId: string): string {
  // Attachment ids are OpenCode-minted (`prt_…`); refuse anything that could
  // walk out of the directory.
  const safe = attachmentId.replace(/[^A-Za-z0-9_-]/g, '_')
  return join(sidecarDir, safe)
}

function writeSidecarAtomic(path: string, bytes: Buffer): void {
  const tmp = `${path}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w', 0o644)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

interface PartRow {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
}

/**
 * Which part rows to touch: for every session, all parts with inline
 * attachments EXCEPT those carrying one of the session's newest `keepNewest`
 * attachments, and never the session's newest message.
 */
export function selectCandidates(
  rows: Array<
    Pick<PartRow, 'id' | 'session_id' | 'message_id' | 'time_created'> & {
      attachmentCount: number
      /** OpenCode's own compaction marked this tool result as cleared: its
       *  attachments are never sent to a model again (message-v2.ts drops
       *  them when `state.time.compacted` is set), so they never count
       *  against the kept window. */
      compacted?: boolean
    }
  >,
  newestMessageBySession: Map<string, string>,
  keepNewest: number,
): Set<string> {
  const bySession = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = bySession.get(r.session_id) ?? []
    list.push(r)
    bySession.set(r.session_id, list)
  }
  const chosen = new Set<string>()
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => b.time_created - a.time_created || (a.id < b.id ? 1 : -1))
    let kept = 0
    for (const r of list) {
      if (r.message_id === newestMessageBySession.get(sessionId)) continue
      if (r.compacted) {
        chosen.add(r.id)
        continue
      }
      if (kept < keepNewest) {
        kept += r.attachmentCount
        continue
      }
      chosen.add(r.id)
    }
  }
  return chosen
}

export async function runAttachmentOffloadPass(opts: OffloadOptions): Promise<OffloadResult> {
  const t0 = Date.now()
  const keepNewest = opts.keepNewest ?? DEFAULT_KEEP_NEWEST
  const maxParts = opts.maxPartsPerPass ?? DEFAULT_MAX_PARTS_PER_PASS
  const minBytes = opts.minBytes ?? OFFLOAD_MIN_BYTES
  const result: OffloadResult = { scanned: 0, offloaded: 0, bytesMoved: 0, skippedBusy: 0, errors: 0, sessions: 0, durationMs: 0 }

  let db: Database
  try {
    db = new Database(opts.dbPath, { readwrite: true })
    db.exec('PRAGMA busy_timeout = 5000')
  } catch (err) {
    logger.warn('[offload] cannot open opencode.db', { path: opts.dbPath, err: (err as Error).message })
    result.errors++
    result.durationMs = Date.now() - t0
    return result
  }

  try {
    mkdirSync(opts.sidecarDir, { recursive: true })
    // Cheap pre-filter in SQL: only rows that can contain a data URL bigger
    // than the floor. The JSON is parsed in JS for the exact decision.
    const rows = db
      .query<Pick<PartRow, 'id' | 'session_id' | 'message_id' | 'time_created'> & { len: number }, [number]>(
        `SELECT id, session_id, message_id, time_created, length(data) AS len
           FROM part
          WHERE length(data) > ?
            AND instr(data, 'data:') > 0
            AND instr(data, '"offloaded":true') = 0`,
      )
      .all(minBytes)
    result.scanned = rows.length
    if (rows.length === 0) return result

    const newestMessageBySession = new Map<string, string>()
    for (const r of db
      .query<{ session_id: string; id: string }, []>(
        `SELECT m.session_id, m.id FROM message m
          WHERE m.time_created = (SELECT MAX(time_created) FROM message WHERE session_id = m.session_id)`,
      )
      .all()) {
      newestMessageBySession.set(r.session_id, r.id)
    }

    // Attachment counts need the JSON; only for the pre-filtered rows.
    const counted = rows.map((r) => {
      const row = db.query<{ data: string }, [string]>('SELECT data FROM part WHERE id = ?').get(r.id)
      let attachmentCount = 0
      let compacted = false
      try {
        const part = JSON.parse(row?.data ?? '{}') as Record<string, unknown>
        attachmentCount = inlineAttachmentsOf(part).filter((a) => isOffloadable(a, minBytes)).length
        const state = part.state as { time?: { compacted?: unknown } } | undefined
        compacted = Boolean(state?.time?.compacted)
      } catch {
        attachmentCount = 0
      }
      return { ...r, attachmentCount, compacted }
    })
    const chosen = selectCandidates(
      counted.filter((r) => r.attachmentCount > 0),
      newestMessageBySession,
      keepNewest,
    )
    result.sessions = new Set(counted.filter((r) => chosen.has(r.id)).map((r) => r.session_id)).size

    const select = db.query<PartRow, [string]>(
      'SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE id = ?',
    )
    const update = db.query<unknown, [string, number, string, number]>(
      'UPDATE part SET data = ?, time_updated = ? WHERE id = ? AND time_updated = ?',
    )
    const nowIso = (opts.now ?? (() => new Date()))().toISOString()

    let touched = 0
    for (const id of chosen) {
      if (touched >= maxParts) break
      const row = select.get(id)
      if (!row) continue
      let part: Record<string, unknown>
      try {
        part = JSON.parse(row.data) as Record<string, unknown>
      } catch {
        result.errors++
        continue
      }
      let moved = 0
      for (const a of inlineAttachmentsOf(part)) {
        if (!isOffloadable(a, minBytes)) continue
        const decoded = decodeDataUrl(a.url as string)
        if (!decoded) continue
        const sidecar = sidecarPathFor(opts.sidecarDir, a.id as string)
        try {
          writeSidecarAtomic(sidecar, decoded.bytes)
        } catch (err) {
          result.errors++
          logger.warn('[offload] sidecar write failed', { sidecar, err: (err as Error).message })
          continue
        }
        const marker: OffloadedMarker = {
          offloaded: true,
          sidecar,
          bytes: decoded.bytes.byteLength,
          mime: a.mime ?? decoded.mime,
          at: nowIso,
        }
        a.kortix = marker
        a.url = OFFLOAD_PLACEHOLDER_URL
        moved += decoded.bytes.byteLength
      }
      if (moved === 0) continue
      opts.beforeUpdate?.(row.id)
      try {
        const res = update.run(JSON.stringify(part), Date.now(), row.id, row.time_updated)
        if ((res as { changes?: number }).changes === 0) {
          result.skippedBusy++
          continue
        }
        result.offloaded++
        result.bytesMoved += moved
        touched++
      } catch (err) {
        result.errors++
        logger.warn('[offload] row update failed', { id: row.id, err: (err as Error).message })
      }
    }
    return result
  } catch (err) {
    result.errors++
    logger.warn('[offload] pass failed', { err: (err as Error).message })
    return result
  } finally {
    try {
      db.close()
    } catch {
      // nothing to do
    }
    result.durationMs = Date.now() - t0
    if (result.offloaded > 0 || result.errors > 0) {
      logger.info('[offload] pass', { ...result, dbPath: opts.dbPath })
    }
  }
}

/** Where OpenCode 1.18 keeps the transcript for this HOME. */
export function opencodeDbPath(home: string): string {
  return join(home, '.local', 'share', 'opencode', 'opencode.db')
}

export function defaultSidecarDir(home: string): string {
  return join(home, '.local', 'share', 'kortix', 'attachments')
}
