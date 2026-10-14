/**
 * The OpenCode session-log adapter (P2.6): OpenCode's own store (`opencode.db`,
 * read through `OpencodeDb.storeSnapshot`) as `kortix.session/2` minor 1
 * records. `boot.ts` starts the journal with it; `service.ts` stops the journal
 * before the runtime stops.
 *
 * ONE MAPPING. `kortix.transcript.v1` is OpenCode's own `{ info, parts }` shape,
 * and `fromV1` (`@kortix/api-contract/session-log`) converts it. The API's
 * capture (P2.7) and backfill (P3.1) convert the v1 mirror with `fromV1`. So
 * this adapter assembles the v1 rows from the store exactly as OpenCode's HTTP
 * serves them (row JSON plus the id columns, parts by id; measured equal on
 * 1.18.23), drops attachment bytes as the mirror does, runs `fromV1`, and then
 * sets only what the daemon knows. Its records deep-equal `fromV1` of the
 * mirror rows of the same session except in these fields:
 * - `seq`: minted once per message (the seq rule below); `fromV1` numbers by position.
 * - `producer`: `opencode` with the store's OpenCode version, not `kortix-v1-import`.
 * - attachments: `ref: blob:<sha256>`, `bytes` and `sha256` of the bytes in the store
 *   (an offloaded attachment's sidecar file). The bytes stay in the store; nothing
 *   uploads them yet (P2.3). `fromV1` without a resolver sets neither (F13), and
 *   the mirror row of a prompt file can carry the `kortix-attachment://` `url` of
 *   the copy the API's capture uploaded, which the daemon never sees.
 * - session: `title`, `created_at` and `todos` from the store, `restore_grade: 'native'`
 *   without `grade_counts`, and the harness history. Thread `title` from the store.
 * The mirror also cuts strings over 200,000 characters, drops `data:` strings
 * inside tool payloads and reshapes a `show` call's input; this adapter keeps
 * them as the model saw them.
 *
 * Threads, ids and attachments follow `fromV1`: a thread is an OpenCode session
 * (thread id = session id), a child is a thread when a tool call names it, with
 * `parent_thread_id` and `spawned_by` from that call; message ids are OpenCode
 * message ids, block ids are part ids. Every session in the store is read: a
 * root replaced by a re-pin stays, as `fromV1` merges it (out of context).
 * A file OpenCode never received is not in its store, so no
 * `undelivered_file` block exists here (pi needs one).
 *
 * At rest. `fromV1` closes a call with no result and marks an open reply
 * `interrupted`. The journal collects at turn end and at daemon stop, when the
 * store is at rest. A message still open then is sent again when it completes:
 * its native hash changes.
 *
 * THE SEQ RULE. `seq` is never reused within a thread: the API keeps a
 * tombstoned row with its seq and rejects a second row on (session, thread,
 * seq). The first time the adapter sees a message it issues the thread's next
 * seq, in `fromV1`'s order (OpenCode's `time_created`, then id, which is the
 * order OpenCode creates them in). A message of the live turn (P4.3b) gets
 * its seq when the journal first sees its v1 frames: OpenCode stores a message
 * before it publishes it, and publishes a thread's messages in the order it
 * creates them, so the turn end's collection reads the same seq. The map lives in
 * `$KORTIX_RUNTIME_STATE_DIR/opencode-session-log.json`, so a restart keeps
 * every seq, and a revert (OpenCode deletes the messages) never hands a deleted
 * message's seq to the next one. On a store without reverts the seqs equal
 * `fromV1`'s. Seqs have gaps.
 *
 * `native_hash` digests the seq and the store rows a record is built from (the
 * message row, its part rows, and a compaction's summary rows).
 *
 * IDS. OpenCode accepts only its own id prefixes (`ses`, `msg`, `prt`). A restore
 * (P6.3, `session-log-restore.ts`) re-keys an id of another harness and records
 * native id → log id in the same file (`ids`); the export renames each row back
 * before `fromV1`, so its records carry the log's ids.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  fromV1,
  type AdapterCapabilities,
  type CapabilityFeatures,
  type ExportCursor,
  type SessionLog,
  type V1Attachment,
  type V1Row,
} from '@kortix/api-contract/session-log'
import type { KortixMessageInfo, KortixPart } from '@kortix/api-contract/transcript'
import { logger } from '@/lib/log/logger'
import { resolveKortixRuntimeStateDirectory } from '@/lib/config/runtime-state-dir'
import type { SessionLogChanges, SessionLogPort, SessionLogRestoreResult } from '../contract/session-log'
import { logChanges, startSessionLogJournal } from '../shared/session-log-journal'
import type { BytesReader } from '../shared/session-log-restore'
import { reconcileSessionLog, isRestoreNote } from '../shared/session-log-boot'
import { readControlPlaneEnv } from '@/lib/kortix-api/relay-context'
import { isOffloadPlaceholder, opencodeDbPath } from './attachment-offload'
import { OpencodeDb, type MessageRow, type StoreSnapshot } from './opencode-db'
import { OPENCODE_HOME } from './paths'
import { readOpenCodeSessionPin } from './runtime-state'
import { restoreOpenCodeSessionLog, type OpenCodeRestoreTarget } from './session-log-restore'

export const OPENCODE_ADAPTER_VERSION = '1.0.0'

const native: CapabilityFeatures = {
  tool_error_channel: false, // openai-chat role:tool has no error flag
  attachments: { user: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'], tool_result: false },
  compaction: ['summary_first_tail'],
  subagents: 'sync', // `task` runs a child session
  todos: true,
  reasoning_replay: 'lowers_to_text', // another model's reasoning is replayed as text
  freeform_tool_input: false,
}
/**
 * `harness_versions` and `schema_minors` name what the oracle suites (`opencode-session-log-restore.test.ts`,
 * `opencode-session-log.test.ts`) passed against, written by hand: `session-log-adapter-versions.test.ts`
 * fails when the pin (runtime-versions.json) or `SESSION_LOG_MINOR` leaves them (README "Bumping a harness").
 */
export const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  harness: 'opencode',
  harness_versions: '1.18.23',
  schema_minors: [1],
  dialects: ['openai-chat'],
  native,
  // A tool-result attachment becomes a follow-up user turn; a layout is emulated.
  rendered: { ...native, attachments: { ...native.attachments, tool_result: true }, compaction: ['summary_first_tail', 'layout'] },
}

type J = Record<string, any>
type Resolved = V1Attachment & { sha256: string }
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const parse = (data: string): J | null => {
  try {
    const value = JSON.parse(data) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as J) : null
  } catch {
    return null
  }
}

/** Per thread: the next seq to issue and the seq of every message ever seen. */
export type SeqState = Record<string, { next: number; seqs: Record<string, number> }>
/** Native id → log id, for the ids a restore re-keyed (session, message and part ids). */
export type IdMap = Record<string, string>

/**
 * Renames every id field of a v1 row: `ids` for session and message ids, `parts` for a part id
 * (and a tool attachment's), which is unique only within its message (the row's id before the rename).
 */
export function renameRow(
  row: { runtime_session_id: string | null; info: J; parts: J[] },
  ids: (id: string) => string,
  parts: (id: string, messageId: string) => string = ids,
): void {
  const messageId = String(row.info.id)
  const re = (o: J, k: string, f: (id: string) => string) => void (typeof o[k] === 'string' && (o[k] = f(o[k])))
  const part = (id: string) => parts(id, messageId)
  if (row.runtime_session_id) row.runtime_session_id = ids(row.runtime_session_id)
  for (const k of ['id', 'sessionID', 'parentID']) re(row.info, k, ids)
  for (const p of row.parts) {
    re(p, 'id', part)
    for (const k of ['messageID', 'sessionID', 'tail_start_id']) re(p, k, ids)
    if (p.state?.metadata) re(p.state.metadata, 'sessionId', ids)
    for (const a of p.state?.attachments ?? []) {
      re(a, 'id', part)
      for (const k of ['messageID', 'sessionID']) re(a, k, ids)
    }
  }
}

/**
 * Takes the bytes out of a file part (a prompt attachment or a tool result's),
 * as the mirror does, and returns them resolved. An offloaded one
 * (attachment-offload.ts) is read from its sidecar; `sidecar` caches that.
 */
function takeBytes(file: J, sidecar: (path: string) => Resolved | null): Resolved | null {
  const url = file.url
  const marker = file.kortix as { offloaded?: boolean; sidecar?: string } | undefined
  delete file.kortix // OpenCode's HTTP drops it, so the mirror never has it
  if (typeof url !== 'string' || !url.startsWith('data:')) return null
  delete file.url
  if (marker?.offloaded && typeof marker.sidecar === 'string') return sidecar(marker.sidecar)
  if (isOffloadPlaceholder(url)) return null
  const comma = url.indexOf(',')
  let bytes: Buffer
  try {
    bytes = url.slice(0, comma).endsWith(';base64') ? Buffer.from(url.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(url.slice(comma + 1)))
  } catch {
    return null // a malformed url: unresolved, as the mirror holds it
  }
  const digest = sha256(bytes)
  return { ref: `blob:${digest}`, bytes: bytes.length, sha256: digest }
}

/** The whole store as a session log, each message's native hash, and the seqs it issued. */
export function openCodeSessionLog(input: {
  sessionId: string
  rootId: string
  store: StoreSnapshot
  seqs: SeqState
  ids?: IdMap
  sidecar?: (path: string) => Resolved | null
}): { log: SessionLog; hashes: Map<string, string>; issued: boolean } {
  const { store } = input
  const sidecar = input.sidecar ?? (() => null)
  const toLog = (id: string) => input.ids?.[id] ?? id
  const rootId = toLog(input.rootId)
  const partRows = new Map<string, Array<{ id: string; data: string }>>()
  for (const p of store.parts) (partRows.get(p.message_id) ?? partRows.set(p.message_id, []).get(p.message_id)!).push(p)
  const attachments = new Map<string, Resolved>()
  const rows: V1Row[] = []
  const rowById = new Map<string, MessageRow>()
  /** Compaction summary rows by the marker they answer: fromV1 folds them into the marker's record. */
  const summaries = new Map<string, MessageRow[]>()
  for (const row of store.messages) {
    const info = parse(row.data)
    if (!info) continue // OpencodeDb.messagePage drops it too
    rowById.set(toLog(row.id), row)
    const parent = typeof info.parentID === 'string' ? toLog(info.parentID) : null
    if (info.summary === true && parent) (summaries.get(parent) ?? summaries.set(parent, []).get(parent)!).push(row)
    const parts: J[] = []
    for (const p of partRows.get(row.id) ?? []) {
      const part = parse(p.data)
      if (!part) continue
      const full: J = { ...part, id: p.id, messageID: row.id, sessionID: row.session_id }
      if (full.type === 'file') {
        const r = takeBytes(full, sidecar)
        if (r) attachments.set(toLog(p.id), r)
      }
      const files = full.state?.attachments
      if (Array.isArray(files)) {
        full.state = { ...full.state, attachments: files.map((a: J, i: number) => {
          const copy = { ...a }
          const r = takeBytes(copy, sidecar)
          if (r) attachments.set(`${toLog(p.id)}#${i}`, r)
          return copy
        }) }
      }
      parts.push(full)
    }
    const v1 = { runtime_session_id: row.session_id, info: { ...info, id: row.id, sessionID: row.session_id }, parts }
    if (input.ids) renameRow(v1, toLog)
    rows.push(v1 as unknown as V1Row)
  }

  const log = fromV1({ session_id: input.sessionId, root_id: rootId, rows }, { harness: 'opencode' })
  const sessions = new Map(store.sessions.map((s) => [toLog(s.id), s]))
  const root = sessions.get(rootId)
  const version = root?.version ?? store.sessions[0]?.version ?? 'unknown'
  const producer = { harness: 'opencode', harness_version: version, adapter_version: OPENCODE_ADAPTER_VERSION }
  const hashes = new Map<string, string>()
  let issued = false
  for (const thread of log.threads) {
    thread.title = sessions.get(thread.thread_id)?.title ?? null
    const state = (input.seqs[thread.thread_id] ??= { next: 1, seqs: {} })
    for (const m of thread.messages) {
      if (state.seqs[m.message_id] === undefined) {
        state.seqs[m.message_id] = state.next++
        issued = true
      }
      m.seq = state.seqs[m.message_id]!
      m.producer = producer
      if (m.role === 'user' && isRestoreNote(m)) m.origin = 'notification'
      for (const b of m.blocks) {
        const r = b.type === 'attachment' ? attachments.get(b.id) : undefined
        if (b.type === 'attachment' && r) Object.assign(b, { ref: r.ref, bytes: r.bytes, sha256: r.sha256 })
        if (b.type !== 'tool_call') continue
        let i = 0
        for (const c of b.result?.content ?? []) {
          if (c.type !== 'attachment') continue
          const t = attachments.get(`${b.id}#${i++}`)
          if (t) Object.assign(c, { ref: t.ref, sha256: t.sha256 })
        }
      }
      const own = [rowById.get(m.message_id), ...(m.kind === 'compaction' ? summaries.get(m.message_id) ?? [] : [])]
      const native = own.map((r) => r && [r.data, partRows.get(r.id) ?? []])
      hashes.set(m.message_id, sha256(JSON.stringify([m.seq, native])))
    }
  }
  const created = root?.time_created
  log.title = root?.title ?? null
  if (typeof created === 'number') log.created_at = new Date(created).toISOString()
  log.restore_grade = 'native'
  delete log.grade_counts
  log.harness = { current: 'opencode', history: [{ harness: 'opencode', version, from_seq: 1, at: log.created_at }] }
  log.todos = store.todos
    .filter((t) => toLog(t.session_id) === rootId)
    .map((t) => ({ content: t.content, status: t.status as SessionLog['todos'][number]['status'], priority: t.priority as SessionLog['todos'][number]['priority'] }))
  return { log, hashes, issued }
}

export function openCodeSessionLogStatePath(): string {
  return join(resolveKortixRuntimeStateDirectory(), 'opencode-session-log.json')
}

/**
 * The persisted seq map and id map, or empty ones (a first boot, or a lost or
 * corrupt file: seqs are issued again from 1 until a restore seeds them from
 * the API's log).
 */
export function readSeqState(path: string): { threads: SeqState; ids: IdMap } {
  if (!existsSync(path)) return { threads: {}, ids: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; threads?: SeqState; ids?: IdMap }
    if (parsed.version === 1 && parsed.threads && typeof parsed.threads === 'object') return { threads: parsed.threads, ids: parsed.ids ?? {} }
  } catch {
    // reported below
  }
  logger.warn('[session-log] the OpenCode seq map does not parse; seqs restart at 1', { path })
  return { threads: {}, ids: {} }
}

export function writeSeqState(path: string, threads: SeqState, ids: IdMap): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify({ version: 1, threads, ...(Object.keys(ids).length && { ids }) }), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * The session-log port over OpenCode's store. `rootId` reads the pinned root
 * each time (a re-pin moves it); no root, no store or an unreadable store
 * answers no changes, never tombstones.
 */
export function createOpenCodeSessionLogPort(options: {
  db: OpencodeDb
  dbPath: string
  sessionId: string
  rootId: () => string | null
  statePath?: string
  /** Where and how `restore` writes (`session-log-restore.ts`); without it `restore` throws. */
  restoreTarget?: Omit<OpenCodeRestoreTarget, 'dbPath' | 'sessionId' | 'statePath'>
}): SessionLogPort {
  const statePath = options.statePath ?? openCodeSessionLogStatePath()
  let { threads: seqs, ids } = readSeqState(statePath)
  const sidecars = new Map<string, Resolved>()
  const sidecar = (path: string): Resolved | null => {
    const known = sidecars.get(path)
    if (known) return known
    try {
      const bytes = readFileSync(path)
      const digest = sha256(bytes)
      const resolved = { ref: `blob:${digest}`, bytes: bytes.length, sha256: digest }
      sidecars.set(path, resolved)
      return resolved
    } catch {
      return null
    }
  }
  const read = (): StoreSnapshot | null => (existsSync(options.dbPath) && options.db.probe().supported ? options.db.storeSnapshot() : null)
  let lastSession: string | null = null
  let unsaved = false
  return {
    capabilities: OPENCODE_CAPABILITIES,
    async changes(cursors: readonly ExportCursor[]): Promise<SessionLogChanges> {
      const rootId = options.rootId()
      const store = rootId ? read() : null
      if (!rootId || !store) return { messages: [], tombstones: [], threads: [] }
      const { log, hashes, issued } = openCodeSessionLog({ sessionId: options.sessionId, rootId, store, seqs, ids, sidecar })
      // The seqs are durable before any record that carries one leaves the box.
      if (issued || unsaved) {
        try {
          writeSeqState(statePath, seqs, ids)
          unsaved = false
        } catch (err) {
          unsaved = true
          logger.warn('[session-log] could not persist the OpenCode seq map; nothing exported', { err: (err as Error).message })
          return { messages: [], tombstones: [], threads: [] }
        }
      }
      const out = logChanges(log, hashes, cursors, lastSession)
      lastSession = out.sessionJson
      return out.changes
    },
    /** Writes `log` into `opencode.db` and the seq map (`session-log-restore.ts`), then reads that map back. */
    async restore(log: SessionLog, seqMax?: Readonly<Record<string, number>>, readAttachment?: BytesReader): Promise<SessionLogRestoreResult> {
      if (!options.restoreTarget) throw new Error('OpenCode session-log restore needs a target (binary, project directory)')
      const target = { ...options.restoreTarget, ...(readAttachment && { readAttachment }), dbPath: options.dbPath, sessionId: options.sessionId, statePath }
      const result = await restoreOpenCodeSessionLog(log, target, seqMax)
      ;({ threads: seqs, ids } = readSeqState(statePath))
      lastSession = null
      unsaved = false
      return result
    },
    /**
     * Every message id of the store (log ids), plus every id the seq map issued: a message
     * OpenCode deleted (a revert) whose tombstone the journal may not have sent. Null when the
     * store or its pinned root is missing (a crash mid-restore), or when the seq map is gone
     * from a store that holds messages (its next export would issue seqs from 1).
     */
    async held() {
      const rootId = options.rootId()
      const store = rootId ? read() : null
      if (!store || !store.sessions.some((s) => s.id === rootId)) return null
      if (!existsSync(statePath) && store.messages.length > 0) return null
      const { log } = openCodeSessionLog({ sessionId: options.sessionId, rootId: rootId!, store, seqs: structuredClone(seqs), ids, sidecar })
      return new Set([...log.threads.flatMap((t) => t.messages.map((m) => m.message_id)), ...Object.values(seqs).flatMap((t) => Object.keys(t.seqs))])
    },
    live(threadId: string, messageId: string) {
      const state = (seqs[threadId] ??= { next: 1, seqs: {} })
      if (state.seqs[messageId] === undefined) {
        state.seqs[messageId] = state.next++
        try {
          writeSeqState(statePath, seqs, ids)
        } catch {
          unsaved = true // changes() writes it before any batch leaves
        }
      }
      return { seq: state.seqs[messageId]! }
    },
  }
}

/**
 * This boot's session log over OpenCode's store (P2.6, P6.4): the boot reconcile
 * (`shared/session-log-boot.ts`, which restores into `opencode.db` when the store is
 * missing or behind the log), then the journal at the generation it returns, before the
 * event loop and the first prompt so the first turn's end flushes it. `target` is the
 * binary and the directory OpenCode serves: `opencode import` runs there. True when it
 * restored. Throws when the reconcile fails: no journal starts. A box without a control
 * plane journals nothing.
 */
export async function bootOpenCodeSessionLog(target: Pick<OpenCodeRestoreTarget, 'bin' | 'cwd'>): Promise<boolean> {
  const sessionId = readControlPlaneEnv().sessionId
  if (!sessionId) return false
  const dbPath = opencodeDbPath(OPENCODE_HOME)
  const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(dbPath), dbPath, sessionId, rootId: readOpenCodeSessionPin, restoreTarget: target })
  const boot = await reconcileSessionLog(port)
  if (boot && startSessionLogJournal(port, boot)) {
    logger.info('[session-log] journal started', { harness: 'opencode', generation: boot.generation, restored: boot.cursors.length > 0, dumpDir: process.env.KORTIX_SESSION_LOG_DUMP_DIR?.trim() || null })
  }
  return (boot?.cursors.length ?? 0) > 0
}
