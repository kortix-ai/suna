/**
 * The OpenCode session-log restore (P6.3): a `kortix.session/2` log written into
 * OpenCode's own store (`opencode.db`), so an OpenCode that serves it sends the
 * model `modelView(log)` next. The boot decides when it runs (P6.4); the port's
 * `restore` calls it.
 *
 * HOW IT WRITES. Each thread becomes one OpenCode session file
 * (`{ info, messages: [{ info, parts }] }`). One `opencode import` writes every
 * message and part of every thread under a holding session: OpenCode's own
 * decoders validate every row, every id is kept, and the session is keyed to the
 * project of the directory it runs in (`cwd`: the project id is re-keyed to the
 * box's). One transaction then gives each thread its session row (the holding
 * row with the thread's id, parent, slug, title, permission, creation and update
 * times), moves the thread's messages and parts to it, and deletes the holding
 * row. A row of any table still keyed to the holding session fails the restore
 * before that delete, which would cascade it away. The store's rows equal one
 * import per thread except the write times (a message's `time_updated`, a part's
 * times): `opencode-session-log-restore-one-import.test.ts` compares them row by row. It
 * costs one process start instead of one per thread plus `--version` (about 2 s
 * each on a 2-vCPU Platinum box). The restore first removes
 * every session from the store, so the store holds exactly the log. A running
 * OpenCode (a warm seed) needs no stop: it reads sessions from the store per
 * request, also a session it served before the restore
 * (`opencode-session-log-restore-golden-cases.test.ts` proves both).
 *
 * PRECONDITION (the caller's, P6.4). The removal deletes every session in the
 * store, work the journal has not sent included. Run the restore only when the
 * native store is missing or behind the log, and never while a turn runs. A
 * crash between the removal and the end of the transaction leaves a store
 * without the root (empty, or only the holding session): the caller treats a
 * store without the pinned root, or without `opencode-session-log.json` after a
 * re-keying restore, as behind.
 *
 * ONE ROOT. The root thread's id is the OpenCode session id, whatever harness
 * minted it (pi's `ses_pi…` is a valid OpenCode id), and the pin names it.
 * Every other parentless thread hangs under the root; a v1 row of an old root
 * (`hidden_reason: 'superseded'`) goes into a session whose parent is the root.
 * Sub-agent threads are child sessions; the call that spawned each one names it
 * (`state.metadata.sessionId`), so the export finds the same threads again.
 *
 * IDS. OpenCode rejects a session id without the `ses` prefix, a message id
 * without `msg` and a part id without `prt`, and it orders a message's parts by
 * id. An id that fails (pi's `msg_…-p0` part ids, another harness's uuids) is
 * re-keyed to an OpenCode-shaped id (ascending in block order for parts), and
 * the seq file keeps native id → log id; the export renames back
 * (`session-log.ts`, IDS).
 *
 * MAPPING. A message `fromV1` built from OpenCode rows (an OpenCode export or a
 * v1 conversion) is written as `toV1` gives it back: exactly the rows it came
 * from, plus the attachment bytes the export took out (data URLs from
 * `readAttachment`, checked against `sha256`). Any other message (pi, another
 * harness) is written for what the model sees:
 * - `context` and `system` messages are not written; OpenCode rebuilds its own.
 * - Text is `model_text ?? text`; an assistant `synthetic` text is not written.
 *   A model-visible harness block is its `fallback_text`.
 * - Reasoning is a reasoning part: OpenCode replays it to the model that wrote
 *   it and lowers it to text for another (modelView `lowers_to_text`).
 * - A tool call is a completed or error tool part with `model_content ?? content`
 *   as its output (OpenCode's pruning marker is `time.compacted`). An input that
 *   is not an object is `{ input }` (a string) or `{}` (`dropped.tool_input`).
 * - An out-of-context user message has `ignored` text parts; an out-of-context
 *   assistant message carries an error, which OpenCode never replays.
 * - A compaction is OpenCode's pair: a user message with a compaction part
 *   (`tail_start_id` = the first kept message) and a summary reply. A `layout`
 *   maps onto that shape: entries before `{ summary }` become parts of the
 *   compaction message, kept messages after it become the tail, `{ text }`
 *   after it a user message after the summary. An entry OpenCode cannot render
 *   in that order counts as `dropped.layout`.
 * - An attachment without bytes, or in an error result, counts as
 *   `dropped.attachment`; a text still stored by reference as `dropped.text`.
 * `dropped` counts a loss only in a message modelView shows next.
 *
 * SEQS. The seq file maps every log message to its seq, and each thread issues
 * new seqs above the floor: `seqMax` (the API's, tombstones included) and every
 * seq of the log. It is written, with the id map, before the store changes: a
 * crash after the import leaves the store with its seqs and ids, never one whose
 * export issues seqs from 1 or sends native ids. `restore` returns, per thread, the hash `openCodeSessionLog`
 * computes for each message of the written store: the journal's next export
 * skips them (C13).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  toV1,
  visibleMessageIds,
  type CompactionBlock,
  type ExportCursor,
  type ModelRef,
  type SessionLog,
  type SessionLogMessage,
  type SessionLogThread,
  type ToolCallBlock,
  type ToolResultContent,
} from '@kortix/api-contract/session-log'
import { KORTIX_TRANSCRIPT_SCHEMA } from '@kortix/api-contract/transcript'
import { logger } from '@/lib/log/logger'
import type { SessionLogRestoreResult } from '../contract/session-log'
import { attachmentBytes, type BytesReader } from '../shared/session-log-restore'
import { readOpencodeVersion } from './assets'
import { OpencodeDb } from './opencode-db'
import { writeOpenCodeSessionPin } from './runtime-state'
import { openCodeSessionLog, openCodeSessionLogStatePath, renameRow, writeSeqState, type IdMap, type SeqState } from './session-log'

/** @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset". */
export interface OpenCodeRestoreTarget {
  /** The OpenCode binary the box runs. */
  bin: string
  /** The directory OpenCode serves (it must exist): the sessions join its project. */
  cwd: string
  /** OpenCode's store. */
  dbPath: string
  /** The Kortix session id. */
  sessionId: string
  /** The environment `opencode import` runs in; default the daemon's. */
  env?: NodeJS.ProcessEnv
  /** The running OpenCode of `bin` (its internal URL): its health answers the version. Without it, or when it does not answer, `bin --version` runs. */
  url?: string
  /** The seq file (`opencode-session-log.json`). */
  statePath?: string
  /** The bytes behind an attachment `ref`; null when they cannot be read. Without it, no attachment is restored. */
  readAttachment?: BytesReader
}

type J = Record<string, any>
type Row = { runtime_session_id: string | null; info: J; parts: J[] }
type Ctx = {
  thread: SessionLogThread
  cwd: string
  bytes: Map<string, Buffer | null>
  drop: (kind: string) => void
  /** The child thread each spawning call names, by call id. */
  children: Map<string, string>
  model: ModelRef
  lastUser: string | null
}

const OPENCODE_PREFIX = { session: 'ses', message: 'msg', part: 'prt' } as const
/** What OpenCode shows the model for a pruned tool output. */
const CLEARED = '[Old tool result content cleared]'
const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
/** An OpenCode-shaped ascending id: `<prefix>_` + 12 hex (ms * 4096 + n) + 14 base62 from `seed`. */
function ascId(prefix: string, ms: number, n: number, seed: string): string {
  const h = createHash('sha256').update(seed).digest()
  const tail = Array.from({ length: 14 }, (_, i) => B62[h[i]! % 62]).join('')
  return `${prefix}_${(BigInt(Math.max(0, ms)) * 4096n + BigInt(n)).toString(16).padStart(12, '0').slice(-12)}${tail}`
}
const msOf = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : undefined
}
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`
const textOf = (c: ToolResultContent[]) => c.flatMap((x) => (x.type === 'text' ? [x.text] : [])).join('\n')
/** A message `fromV1` built from OpenCode rows: `toV1` gives those rows back. */
const fromOpenCodeRows = (t: SessionLogThread, m: SessionLogMessage) =>
  Object.values(t.ext ?? {}).some((e) => e.version === KORTIX_TRANSCRIPT_SCHEMA) && (m.producer.harness === 'kortix-v1-import' || m.producer.harness === 'opencode')

/** The rows `fromV1` read, with the attachment bytes put back. A file part without bytes cannot be imported and is left out. */
function v1Rows(log: SessionLog, t: SessionLogThread, m: SessionLogMessage, c: Ctx): Row[] {
  const rows = toV1({ ...log, threads: [{ ...t, messages: [m] }] }).rows as unknown as Row[]
  const blocks = new Map(m.blocks.map((b) => [b.id, b]))
  const bytesOf = (a: { ref?: string; mime: string }) => {
    const bytes = a.ref ? c.bytes.get(a.ref) : null
    if (!bytes && a.ref) c.drop('attachment')
    return bytes ? dataUrl(a.mime, bytes) : null
  }
  for (const row of rows) {
    row.parts = row.parts.filter((p) => {
      if (p.type === 'file' && !String(p.url ?? '').startsWith('data:')) {
        const b = blocks.get(p.id)
        p.url = b?.type === 'attachment' ? bytesOf(b) : null
        return p.url !== null
      }
      if (p.type === 'tool' && p.state && (typeof p.state.input !== 'object' || p.state.input === null || Array.isArray(p.state.input))) {
        p.state.input = {} // OpenCode requires an object; a conversion that lost it has null
        c.drop('tool_input')
      }
      if (p.type === 'tool' && Array.isArray(p.state?.attachments)) {
        const b = blocks.get(p.id) as ToolCallBlock | undefined
        const items = (b?.result?.content ?? []).filter((x) => x.type === 'attachment')
        p.state.attachments = p.state.attachments.filter((a: J, i: number) => {
          if (String(a.url ?? '').startsWith('data:')) return true
          a.url = items[i] ? bytesOf(items[i]!) : null
          return a.url !== null
        })
      }
      return true
    })
  }
  return rows
}

function assistantInfo(m: SessionLogMessage, c: Ctx, over: J = {}): J {
  const u = m.usage
  const model = m.model ?? c.model
  return {
    id: m.message_id, role: 'assistant', parentID: c.lastUser ?? m.message_id,
    modelID: model.model, providerID: model.provider, ...(model.variant !== undefined && { variant: model.variant }),
    mode: m.agent ?? c.thread.agent ?? 'build', agent: m.agent ?? c.thread.agent ?? 'build', path: { cwd: c.cwd, root: c.cwd },
    cost: u?.cost ?? 0, tokens: { input: u?.input ?? 0, output: u?.output ?? 0, reasoning: u?.reasoning ?? 0, cache: { read: u?.cache_read ?? 0, write: u?.cache_write ?? 0 } },
    ...over,
  }
}

const userInfo = (m: SessionLogMessage, c: Ctx, id = m.message_id): J => {
  const model = m.model ?? c.model
  return { id, role: 'user', agent: m.agent ?? c.thread.agent ?? 'build', model: { providerID: model.provider, modelID: model.model } }
}

/** The parts a user message shows the model. `textOnly`: a layout entry that keeps only the text. */
function userParts(m: SessionLogMessage, c: Ctx, ignored: boolean, textOnly = false): J[] {
  return m.blocks.flatMap((b): J[] => {
    if (b.type === 'text') {
      return [{ id: b.id, type: 'text', text: b.model_text ?? b.text, ...(b.synthetic && { synthetic: true }), ...(ignored && { ignored: true }) }]
    }
    if (b.type === 'harness' && b.model_visible && b.fallback_text) return [{ id: b.id, type: 'text', text: b.fallback_text, synthetic: true, ...(ignored && { ignored: true }) }]
    if (b.type !== 'attachment' || ignored || textOnly) return []
    const bytes = b.ref ? c.bytes.get(b.ref) : null
    if (!bytes) {
      if (b.ref) c.drop('attachment')
      return []
    }
    return [{ id: b.id, type: 'file', mime: b.mime, ...(b.name !== undefined && { filename: b.name }), url: dataUrl(b.mime, bytes) }]
  })
}

function toolPart(b: ToolCallBlock, m: SessionLogMessage, c: Ctx): J {
  const r = b.result
  const input = typeof b.input === 'string' ? { input: b.input } : b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? (b.input as J) : {}
  if (typeof b.input !== 'string' && input !== b.input) c.drop('tool_input')
  const start = msOf(b.started_at) ?? msOf(m.created_at) ?? 0
  const time = { start, end: msOf(b.ended_at) ?? start }
  const child = c.children.get(b.call_id)
  const metadata: J = child ? { sessionId: child } : {}
  if (!r) {
    c.drop('tool_result') // a call at rest has a result (rule C2); OpenCode would show an interrupted one
    return { id: b.id, type: 'tool', callID: b.call_id, tool: b.name, state: { status: 'error', input, error: '', metadata, time } }
  }
  const cleared = !!r.model_content && r.model_content.length === 1 && textOf(r.model_content) === CLEARED
  const shown = r.model_content && !cleared ? r.model_content : r.content
  const files = shown.filter((x) => x.type === 'attachment')
  let state: J
  if (r.is_error) {
    for (const f of files) if (f.ref) c.drop('attachment') // OpenCode's error state has no attachments
    state = { status: 'error', input, error: textOf(shown), metadata, time }
  } else {
    const attachments = files.flatMap((a, i) => {
      const bytes = a.ref ? c.bytes.get(a.ref) : null
      if (!bytes && a.ref) c.drop('attachment')
      return bytes ? [{ id: `${b.id}-a${i}`, type: 'file', mime: a.mime, url: dataUrl(a.mime, bytes) }] : []
    })
    state = {
      status: 'completed', input, output: textOf(shown), title: b.title ?? '', metadata,
      time: { ...time, ...(cleared && { compacted: msOf(r.cleared_at) ?? time.end }) }, ...(attachments.length && { attachments }),
    }
  }
  return { id: b.id, type: 'tool', callID: b.call_id, tool: b.name, state }
}

function assistantRow(m: SessionLogMessage, c: Ctx): Row {
  const parts = m.blocks.flatMap((b): J[] => {
    if (b.type === 'text') {
      if (b.synthetic) return []
      return [{ id: b.id, type: 'text', text: b.model_text ?? b.text }]
    }
    if (b.type === 'reasoning') return [{ id: b.id, type: 'reasoning', text: b.text, time: { start: 0, end: 0 } }]
    if (b.type === 'tool_call') return [toolPart(b, m, c)]
    if (b.type === 'step') return [b.phase === 'start' ? { id: b.id, type: 'step-start' } : { id: b.id, type: 'step-finish', reason: 'stop', cost: 0, tokens: ZERO_TOKENS }]
    if (b.type === 'harness' && b.model_visible && b.fallback_text) return [{ id: b.id, type: 'text', text: b.fallback_text }]
    return []
  })
  const finish = m.finish === 'tool_calls' ? 'tool-calls' : m.finish === 'length' ? 'length' : 'stop'
  // OpenCode never replays an errored reply: the one way to keep a message out of its context.
  const hidden = m.in_context ? {} : { error: { name: 'UnknownError', data: { message: m.error?.message ?? `hidden: ${m.hidden_reason ?? 'out of context'}` } } }
  return { runtime_session_id: c.thread.thread_id, info: assistantInfo(m, c, { finish, ...hidden }), parts }
}

/** OpenCode's compaction pair for a compaction message, plus a user message for `{ text }` entries after the summary. */
function compactionRows(m: SessionLogMessage, block: CompactionBlock, msgs: SessionLogMessage[], written: Set<string>, c: Ctx): Row[] {
  const byId = new Map(msgs.map((x) => [x.message_id, x]))
  const at = msgs.indexOf(m)
  const layout = block.layout
  const si = layout ? layout.findIndex((e) => 'summary' in e) : -1
  const pre: J[] = []
  const post: string[] = []
  let first: string | null = block.first_kept_message_id
  if (layout) {
    first = null
    for (const [i, e] of (si < 0 ? layout : layout.slice(0, si)).entries()) {
      if ('text' in e) pre.push({ id: `${block.id}-L${i}`, type: 'text', text: e.text })
      else if ('message_id' in e) {
        const kept = byId.get(e.message_id)
        if (kept?.role !== 'user') c.drop('layout') // OpenCode shows only the compaction message before the summary
        else pre.push(...userParts(kept, c, false, e.text_only).map((p, j) => ({ ...p, id: `${block.id}-L${i}-${j}` })))
      }
    }
    const after = si < 0 ? [] : layout.slice(si + 1)
    const keptIds = after.flatMap((e) => ('message_id' in e ? [e.message_id] : []))
    const texts = after.flatMap((e) => ('text' in e ? [e.text] : []))
    post.push(...texts)
    if (keptIds.length) {
      first = keptIds[0]!
      const k = msgs.findIndex((x) => x.message_id === first)
      const run = k < 0 ? [] : msgs.slice(k, at).filter((x) => x.in_context && x.kind === 'turn').map((x) => x.message_id)
      // OpenCode keeps the contiguous run before the marker, then shows the texts after it.
      if (JSON.stringify(run) !== JSON.stringify(keptIds) || after.findIndex((e) => 'text' in e) < after.findLastIndex((e) => 'message_id' in e)) c.drop('layout')
    }
  }
  // The first kept message OpenCode holds: at or after the cut point, before the marker.
  const k = first ? msgs.findIndex((x) => x.message_id === first) : -1
  const tail = k < 0 ? undefined : msgs.slice(k, at).find((x) => written.has(x.message_id))?.message_id
  if (first && !tail) c.drop('layout')
  const sid = c.thread.thread_id
  const marker = { id: block.id, type: 'compaction', auto: block.trigger === 'auto' || block.trigger === 'overflow', ...(block.trigger === 'overflow' && { overflow: true }), ...(tail && { tail_start_id: tail }) }
  const summaryId = `${m.message_id}-summary`
  const rows: Row[] = [
    { runtime_session_id: sid, info: userInfo(m, c), parts: [...pre, marker] },
    {
      runtime_session_id: sid,
      info: assistantInfo({ ...m, agent: 'compaction' }, c, { id: summaryId, parentID: m.message_id, summary: true, mode: 'compaction', finish: 'stop' }),
      parts: [{ id: `${block.id}-summary`, type: 'text', text: block.summary ?? '' }],
    },
  ]
  if (post.length) rows.push({ runtime_session_id: sid, info: userInfo(m, c, `${m.message_id}-post`), parts: post.map((text, i) => ({ id: `${block.id}-P${i}`, type: 'text', text, synthetic: true })) })
  return rows
}

/** One thread's rows in seq order, each message's rows in OpenCode's order with strictly increasing times. */
function threadRows(log: SessionLog, t: SessionLogThread, ctx: Omit<Ctx, 'thread' | 'drop' | 'children' | 'model' | 'lastUser'>, drop: (kind: string) => void): Row[] {
  const msgs = [...t.messages].sort((a, b) => a.seq - b.seq)
  const visible = visibleMessageIds(t.messages)
  let current = ''
  const children = new Map<string, string>()
  for (const child of log.threads) if (child.parent_thread_id === t.thread_id && child.spawned_by) children.set(child.spawned_by.call_id, child.thread_id)
  for (const b of msgs.flatMap((m) => m.blocks)) if (b.type === 'subtask' && b.call_id && log.threads.some((x) => x.thread_id === b.thread_id)) children.set(b.call_id, b.thread_id)
  const c: Ctx = {
    ...ctx, thread: t, children, lastUser: null,
    drop: (kind) => void (visible.has(current) && drop(kind)),
    model: log.selection.model ?? msgs.find((m) => m.model)?.model ?? { provider: 'unknown', model: 'unknown' },
  }
  const written = new Set<string>()
  const out: Row[] = []
  let prev = -Infinity
  let prevId = ''
  for (const m of msgs) {
    current = m.message_id
    if (m.model) c.model = m.model
    let rows: Row[] = []
    const block = m.blocks.find((b): b is CompactionBlock => b.type === 'compaction')
    if (m.role === 'system' || m.kind === 'context') rows = []
    else if (fromOpenCodeRows(t, m)) rows = v1Rows(log, t, m, c)
    else if (m.kind === 'compaction') rows = block && m.in_context ? compactionRows(m, block, msgs, written, c) : []
    else if (m.role === 'user') {
      const parts = userParts(m, c, !m.in_context)
      rows = parts.length ? [{ runtime_session_id: t.thread_id, info: userInfo(m, c), parts }] : []
    } else rows = [assistantRow(m, c)]
    // OpenCode orders a session's messages by time, then id: a stored row keeps a time no earlier
    // than the row before (its id breaks a tie, as OpenCode minted it); any other row comes strictly after.
    const want = msOf(m.created_at)
    for (const row of rows) {
      const stored = row.info.time?.created as number | undefined
      const own = stored ?? (row === rows[0] ? want : undefined)
      const id = String(row.info.id)
      const tie = own === prev && stored !== undefined && id.startsWith(OPENCODE_PREFIX.message) && prevId.startsWith(OPENCODE_PREFIX.message) && id > prevId
      const created = own !== undefined && (own > prev || tie) ? own : prev + 1
      prevId = id
      row.info.time = { ...row.info.time, created, ...(row.info.role === 'assistant' && { completed: Math.max(row.info.time?.completed ?? msOf(m.completed_at) ?? created, created) }) }
      prev = created
      row.runtime_session_id ??= t.thread_id
    }
    // An assistant row answers the user message before it (a converted row may name none).
    for (const row of rows) if (row.info.role === 'assistant') row.info.parentID ??= c.lastUser ?? row.info.id
    if (rows.length) written.add(m.message_id)
    // A text the restore answer could not read in full keeps its preview (`sessionLogFromRestore`).
    for (const b of rows.length ? m.blocks : []) {
      const shown = b.type === 'tool_call' ? b.result?.model_content ?? b.result?.content ?? [] : [b]
      for (const x of shown) if (x.type === 'text' && (x as { ref?: string }).ref) c.drop('text')
    }
    if (m.role === 'user' && m.kind === 'turn' && rows.length) c.lastUser = m.message_id
    out.push(...rows)
  }
  return out
}

/**
 * Every id OpenCode would reject, mapped to an OpenCode-shaped one: a session without `ses`, a
 * message without `msg`, and every part of a message whose part ids lack `prt` or do not ascend.
 * Part ids are unique only within a message, so a part's key is `<message id>\0<part id>`.
 */
function rekey(rows: Row[]): IdMap {
  const map: IdMap = {}
  const set = (id: string, to: string) => void (map[id] ??= to)
  for (const row of rows) {
    const t = row.info.time.created as number
    const msg = String(row.info.id)
    if (row.runtime_session_id && !row.runtime_session_id.startsWith(OPENCODE_PREFIX.session)) set(row.runtime_session_id, `ses_${sha256(`ses\0${row.runtime_session_id}`).slice(0, 26)}`)
    if (!msg.startsWith(OPENCODE_PREFIX.message)) set(msg, ascId('msg', t, 0, `msg\0${msg}`))
    const ids = row.parts.map((p) => String(p.id))
    if (!ids.every((id, i) => id.startsWith(OPENCODE_PREFIX.part) && (i === 0 || ids[i - 1]! < id))) ids.forEach((id, i) => set(`${msg}\0${id}`, ascId('prt', t, i, `prt\0${msg}\0${id}`)))
    for (const [j, a] of row.parts.flatMap((p) => (p.state?.attachments ?? []) as J[]).entries()) {
      if (!String(a.id).startsWith(OPENCODE_PREFIX.part)) set(`${msg}\0${a.id}`, ascId('prt', t, ids.length + j, `prt\0${msg}\0${a.id}`))
    }
  }
  return map
}

/** Rows grouped into the session files `opencode import` reads, the root first. */
function sessionFiles(log: SessionLog, rows: Row[], toNative: IdMap, cwd: string, version: string): J[] {
  const native = (id: string) => toNative[id] ?? id
  const threads = new Map(log.threads.map((t) => [native(t.thread_id), t]))
  const rootId = native(log.threads[0]!.thread_id)
  const bySession = new Map<string, Row[]>()
  for (const row of rows) (bySession.get(row.runtime_session_id!) ?? bySession.set(row.runtime_session_id!, []).get(row.runtime_session_id!)!).push(row)
  if (!bySession.has(rootId)) bySession.set(rootId, [])
  return [...bySession].sort(([a], [b]) => (a === rootId ? -1 : b === rootId ? 1 : 0)).map(([id, own]) => {
    const t = threads.get(id)
    const times = own.map((r) => r.info.time.created as number)
    const created = msOf(id === rootId ? log.created_at : t?.created_at) ?? Math.min(...times, Date.now())
    const parent = id === rootId ? null : native(t?.parent_thread_id ?? rootId)
    return {
      info: {
        id, slug: `restored-${sha256(id).slice(0, 8)}`, projectID: 'global', directory: cwd, title: t?.title ?? log.title ?? 'Restored session', version,
        time: { created, updated: Math.max(created, ...times) },
        // A native sub-agent session denies todowrite and task (OpenCode's task tool).
        ...(parent && { parentID: parent, permission: [{ permission: 'todowrite', pattern: '*', action: 'deny' }, { permission: 'task', pattern: '*', action: 'deny' }] }),
      },
      messages: own.map((r) => ({
        info: { ...r.info, sessionID: id },
        parts: r.parts.map((p) => ({
          ...p, sessionID: id, messageID: r.info.id,
          ...(p.state?.attachments && { state: { ...p.state, attachments: p.state.attachments.map((a: J) => ({ ...a, sessionID: id, messageID: r.info.id })) } }),
        })),
      })),
    }
  })
}

async function run(target: OpenCodeRestoreTarget, args: string[]): Promise<string> {
  const proc = Bun.spawn([target.bin, ...args], { cwd: target.cwd, env: { ...(target.env ?? process.env), OPENCODE_DB: target.dbPath }, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), 60_000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`opencode ${args.join(' ')} exited ${code}: ${(stderr || stdout).trim().slice(0, 2_000)}`)
  return stdout
}

/**
 * Every session file into the store with ONE `opencode import` (see the header, HOW IT WRITES):
 * the files' messages under a holding session, then one transaction moves each file's messages
 * and parts to its own session row. `files[0]` is the root.
 */
async function importSessions(target: OpenCodeRestoreTarget, files: J[], dir: string): Promise<void> {
  const hold = `ses_${sha256(`hold\0${files[0]!.info.id}`).slice(0, 26)}`
  const path = join(dir, 'sessions.json')
  writeFileSync(path, JSON.stringify({ info: { ...files[0]!.info, id: hold }, messages: files.flatMap((f) => f.messages) }), { mode: 0o600 })
  const out = await run(target, ['--pure', 'import', path])
  if (!out.includes(`Imported session: ${hold}`)) throw new Error(`opencode import did not import the restore: ${out.trim().slice(0, 500)}`)
  const db = new Database(target.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON')
    const row = db.query('SELECT * FROM session WHERE id = ?').get(hold) as J | null
    if (!row) throw new Error('opencode import wrote no session row')
    const cols = Object.keys(row)
    const insert = db.query(`INSERT INTO session (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    const moveMessage = db.query('UPDATE message SET session_id = ?1 WHERE id = ?2 AND session_id = ?3')
    const moveParts = db.query('UPDATE part SET session_id = ?1 WHERE message_id = ?2 AND session_id = ?3')
    const tables = db
      .query("SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'session_id')")
      .all() as Array<{ name: string }>
    db.transaction(() => {
      for (const { info, messages } of files) {
        const own: J = { ...row, id: info.id, parent_id: info.parentID ?? null, slug: info.slug, title: info.title, permission: info.permission ? JSON.stringify(info.permission) : null, time_created: info.time.created, time_updated: info.time.updated }
        insert.run(...cols.map((c) => own[c]))
        for (const m of messages as J[]) {
          moveMessage.run(info.id, m.info.id, hold)
          moveParts.run(info.id, m.info.id, hold)
        }
      }
      // A row still keyed to the holding session would go with it (ON DELETE CASCADE): refuse instead.
      for (const { name } of tables) {
        const left = (db.query(`SELECT count(*) AS n FROM "${name}" WHERE session_id = ?`).get(hold) as { n: number }).n
        if (left) throw new Error(`the restore left ${left} row(s) of ${name} on the holding session`)
      }
      db.run('DELETE FROM session WHERE id = ?', [hold])
    })()
  } finally {
    db.close()
  }
}

/** Every session out of the store (cascading to messages, parts and todos), so it holds exactly the log. */
function clearStore(dbPath: string): void {
  if (!existsSync(dbPath)) return
  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON')
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name))
    if (!tables.has('session')) return
    db.transaction(() => {
      if (tables.has('event_sequence')) db.run('DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM session)')
      db.run('DELETE FROM session')
    })()
  } finally {
    db.close()
  }
}

function writeTodos(dbPath: string, sessionId: string, todos: SessionLog['todos']): void {
  if (!todos.length) return
  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const now = Date.now()
    const insert = db.query('INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
    db.transaction(() => todos.forEach((t, i) => insert.run(sessionId, t.content, t.status, t.priority ?? 'medium', i, now, now)))()
  } finally {
    db.close()
  }
}

/**
 * `seqMax`: the highest seq the API holds per thread, tombstones included (P6.1 `seq_max`).
 * `write` puts the session files into the cleared store; a test passes one import per file to compare.
 * @deprecated OpenCode is sunset: no new code. See harness/README.md "OpenCode sunset".
 */
export async function restoreOpenCodeSessionLog(
  input: SessionLog,
  target: OpenCodeRestoreTarget,
  seqMax: Readonly<Record<string, number>> = {},
  write: (target: OpenCodeRestoreTarget, files: J[], dir: string) => Promise<void> = importSessions,
): Promise<SessionLogRestoreResult> {
  const log = structuredClone(input)
  const root = log.threads.find((t) => t.parent_thread_id === null) ?? log.threads[0]
  if (!root) throw new Error('session log has no thread')
  // Another parentless thread (an old root another harness kept) hangs under the root; none is the root itself.
  for (const t of log.threads) if (t !== root && t.parent_thread_id === null) t.parent_thread_id = root.thread_id
  log.threads = [root, ...log.threads.filter((t) => t !== root && t.thread_id !== root.thread_id)]
  const dropped: Record<string, number> = {}
  const drop = (kind: string) => void (dropped[kind] = (dropped[kind] ?? 0) + 1)
  const bytes = await attachmentBytes(log, target.readAttachment)
  const rows = log.threads.flatMap((t) => threadRows(log, t, { cwd: target.cwd, bytes }, drop))
  // A row in the future would sort after the next prompt: move the whole log back.
  const latest = Math.max(0, ...rows.map((r) => r.info.time.created as number))
  if (latest >= Date.now()) for (const r of rows) for (const k of ['created', 'completed']) if (typeof r.info.time[k] === 'number') r.info.time[k] -= latest - Date.now() + 1_000

  const toNative = rekey(rows)
  for (const row of rows) renameRow(row, (id) => toNative[id] ?? id, (id, msg) => toNative[`${msg}\0${id}`] ?? id)
  const rootId = toNative[root.thread_id] ?? root.thread_id
  if (rootId !== root.thread_id) logger.warn('[session-log] OpenCode rejects the root thread id; the restore re-keys it', { rootId })
  const version = (target.url && (await readOpencodeVersion(target.url))) || (await run(target, ['--version'])).trim() || 'unknown'
  const files = sessionFiles(log, rows, toNative, target.cwd, version)

  // The seq map (every log seq, each thread's next seq above the floor) and native id → log id
  // (a part key `<message id>\0<part id>` names the part id). They do not depend on the store, so
  // they are on disk before the store changes: a crash after the import never leaves a store
  // whose export issues seqs from 1 or sends native ids.
  const seqs: SeqState = {}
  for (const t of log.threads) {
    const floor = Math.max(seqMax[t.thread_id] ?? 0, ...t.messages.map((m) => m.seq))
    seqs[t.thread_id] = { next: floor + 1, seqs: Object.fromEntries(t.messages.map((m) => [m.message_id, m.seq])) }
  }
  const ids = Object.fromEntries(Object.entries(toNative).map(([key, native]) => [native, key.slice(key.indexOf('\0') + 1)]))
  const statePath = target.statePath ?? openCodeSessionLogStatePath()
  writeSeqState(statePath, seqs, ids)

  const dir = mkdtempSync(join(tmpdir(), 'kortix-oc-restore-'))
  try {
    clearStore(target.dbPath)
    await write(target, files, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  writeTodos(target.dbPath, rootId, log.todos)
  writeOpenCodeSessionPin(rootId)

  const store = new OpencodeDb(target.dbPath).storeSnapshot()
  if (!store) throw new Error('the restored OpenCode store does not read back')
  const { log: written, hashes, issued } = openCodeSessionLog({ sessionId: target.sessionId, rootId, store, seqs, ids })
  // A written row the log has no record for (a layout's `{ text }` message) got its seq above the floor.
  if (issued) writeSeqState(statePath, seqs, ids)
  const cursors = written.threads.map((t): ExportCursor => ({
    thread_id: t.thread_id,
    last_seq: Math.max(-1, ...t.messages.map((m) => m.seq)),
    native_hashes: Object.fromEntries(t.messages.map((m) => [m.message_id, hashes.get(m.message_id)!])),
  }))
  if (Object.keys(dropped).length) logger.warn('[session-log] restore could not write all model-visible content', { dropped })
  return { cursors, dropped }
}
