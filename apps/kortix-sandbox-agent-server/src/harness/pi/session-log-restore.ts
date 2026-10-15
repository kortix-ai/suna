/**
 * The pi session-log restore (P6.2): a `kortix.session/2` log written into pi's
 * native store, the dump `PiRuntime` loads at start (`piDumpPath`), so a pi that
 * boots on it sends the model `modelView(log)` next. It runs before the runtime
 * starts; the boot decides when (P6.4). The port's `restore` calls it.
 *
 * What it writes:
 * - The root thread as pi `SessionManager` entries after a session header, one
 *   linear branch in seq order, with the Kortix message id (`messageIds`) and
 *   the seq (`seqs`, the seq rule in `session-log.ts`) of each entry. pi runs
 *   under the log's root thread id (`PiDump.rootId`, which the runtime adopts),
 *   so a session that started on another harness keeps one root.
 * - The seq floor: every seq the API holds for a thread (`seq_max`, tombstones
 *   included) and every seq of the log, written or not. A trailing `custom`
 *   entry (`kortix.seq-floor`) maps the root's floor, and a child's `nextSeq`
 *   starts above it, so a new message never takes a held seq.
 * - Each sub-agent thread as a child's `AgentMessage[]`: the same entries, then
 *   pi's own projection (`buildSessionProjection`), because a child has no
 *   entries. Its seqs and message ids by index.
 * - The v1 transcript of each thread (`toV1`), which the UI and the export read
 *   for display text and part ids.
 *
 * Mapping (the inverse of `session-log.ts`, plus what another harness wrote):
 * - A `context` message (a system prompt) is not written: pi builds its own
 *   from config and adds it at the next prompt. modelView omits it too. The
 *   thread's last one names the id pi's rebuilt prompt takes (`contextId`), so
 *   a restore replaces that record: N restores leave one per thread, not N.
 * - User text is the display `text`; a `model_text` that differs is a
 *   `context_edit` replacement, which is what pi sends. An `automation` user
 *   message is a `custom_message`. An image is pi image content with the bytes
 *   `readAttachment` returns for its `ref` (checked against `sha256`); one whose
 *   bytes cannot be read, and any other file type, is not written and counts as
 *   `dropped.attachment`. One with no `ref` (F13: the bytes were never stored)
 *   is not written either; modelView has nothing for it, so it is not counted.
 *   A model-invisible block stays in the v1 transcript only.
 * - Assistant content is what the model saw: `model_text ?? text`, no
 *   synthetic text, reasoning as `thinking` (pi-ai replays it to the model that
 *   wrote it; `reasoning.ts` drops it from a request to any other), signatures from `ext.pi`.
 *   A call input that is not an object is `{ input }` (a string) or `{}`
 *   (`dropped.tool_input`).
 * - A tool result is a `toolResult` entry (`ext.pi.native_id` keeps pi's entry
 *   id); `model_content` is a `context_edit` replacement on it. A synthetic
 *   "No result provided" closure is not written: pi-ai sends exactly that for a
 *   call with no result.
 * - An out-of-context message is a `context_edit` with no replacement, except
 *   an errored or aborted reply: its `stopReason` keeps pi-ai from replaying it.
 *   An in-context errored or aborted reply (another harness replays it) is
 *   written as `stop`/`toolUse`.
 * - A compaction with a summary and no `layout` is a native pi compaction:
 *   `firstKeptEntryId` is the entry of `first_kept_message_id` (the compaction
 *   itself, keeping none, when the cut point is missing). Any other compaction
 *   (a `layout`, a null summary) hides every model-visible entry before it and
 *   renders its layout in order as `custom_message` entries (the summary in pi's
 *   compaction framing), each with a new seq above the thread's.
 *
 * `dropped` counts a loss only in a message modelView shows next (in context,
 * not summarized away): everything else the model would not see anyway.
 *
 * `restore` reads the store back as `PiRuntime.sessionLogSnapshot()` would and
 * returns, per thread, the hash `piSessionLog` computes for each message: the
 * journal's next export skips them (C13), so the API keeps the records it has
 * and never receives the lossy re-derivation of a log from another harness.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { buildSessionProjection, type SessionEntry } from '@earendil-works/pi-coding-agent'
import {
  toV1,
  type CompactionBlock,
  type ExportCursor,
  type SessionLog,
  type SessionLogMessage,
  type SessionLogThread,
  type ToolResultContent,
} from '@kortix/api-contract/session-log'
import type { KortixMessage } from '@kortix/api-contract/transcript'
import { logger } from '@/lib/log/logger'
import type { SessionLogRestoreResult } from '../contract/session-log'
import { piDumpPath, type PiChildDump, type PiDump } from './runtime'
import { attachmentBytes, visibleMessageIds, type BytesReader } from '../shared/session-log-restore'
import { PI_NO_RESULT, piSessionLog, type PiSessionSnapshot } from './session-log'

export interface PiRestoreTarget {
  /** `cfg.piStateDir`: where the runtime reads its dump. */
  stateDir: string
  /** The Kortix session id (`KORTIX_SESSION_ID`). */
  sessionId: string
  /** The workspace: the session header's cwd when the log has none from pi. */
  cwd: string
  /** The bytes behind an attachment `ref`; null when they cannot be read. Without it, no image is restored. */
  readAttachment?: BytesReader
}

type J = Record<string, any>
const PI = 'pi'
const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}
const piData = (x: { ext?: J } | undefined): J => x?.ext?.[PI]?.data ?? {}
const API: Record<string, string> = { 'openai-chat': 'openai-completions', 'openai-responses': 'openai-responses', 'anthropic-messages': 'anthropic-messages' }
const STOP: Record<string, string> = { stop: 'stop', tool_calls: 'toolUse', length: 'length', error: 'error', aborted: 'aborted' }
// pi's compaction framing (pi-coding-agent `COMPACTION_SUMMARY_PREFIX`, not exported).
const SUMMARY_PREFIX = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const SUMMARY_SUFFIX = '\n</summary>'

function piUsage(u: SessionLogMessage['usage']) {
  const x = u ?? { input: 0, output: 0, cache_read: 0, cache_write: 0 }
  return {
    input: x.input, output: x.output, cacheRead: x.cache_read, cacheWrite: x.cache_write, ...(x.reasoning !== undefined ? { reasoning: x.reasoning } : {}),
    totalTokens: x.input + x.output + x.cache_read + x.cache_write,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: x.cost ?? 0 },
  }
}

/** One thread's entries as pi appends them: a linear branch, each entry's message id and seq. */
class Chain {
  /** The highest seq the thread holds or this restore used. */
  floor = 0
  readonly entries: J[] = []
  readonly ids: Record<string, string> = {}
  readonly seqs: Record<string, number> = {}
  /** Entries that put content in the model context and are not hidden yet. */
  visible: string[] = []
  push(fields: J, record?: { id: string; seq: number }): J {
    const entry: J = { ...fields, parentId: this.entries.at(-1)?.id ?? null }
    this.entries.push(entry)
    if (record) {
      this.ids[entry.id] = record.id
      this.seqs[entry.id] = record.seq
    }
    if ((entry.type === 'message' && entry.message.role !== 'system') || entry.type === 'custom_message') this.visible.push(entry.id)
    if (entry.type === 'context_edit' && entry.replacement === null) this.visible = this.visible.filter((id) => id !== entry.targetId)
    return entry
  }
  hide(targetId: string, timestamp: string): void {
    this.push({ type: 'context_edit', id: `${targetId}.hide`, timestamp, targetId, replacement: null })
  }
}

/** `drop` counts a loss in the message being written, when the model sees it next (`visibleMessageIds`). */
type Ctx = { images: Map<string, string | null>; drop: (kind: string) => void }

/** pi image content for an attachment, or null when its bytes are missing or pi cannot send its type. */
function image(a: { ref?: string; mime: string }, ctx: Ctx): J | null {
  const data = a.ref ? ctx.images.get(a.ref) : null
  return data && a.mime.startsWith('image/') ? { type: 'image', data, mimeType: a.mime } : null
}

/** `shown`: the model gets this content (no `model_content` replaces it). */
function resultContent(content: ToolResultContent[], ctx: Ctx, shown: boolean): J[] {
  return content.flatMap((c) => {
    if (c.type === 'text') return [{ type: 'text', text: c.text }]
    const img = image(c, ctx)
    if (!img && shown && c.ref) ctx.drop('attachment')
    return img ? [img] : []
  })
}

/** User content: what pi stores (display text) and what the model gets. */
function userContent(m: SessionLogMessage, ctx: Ctx, textOnly = false): { raw: J[]; model: J[] } {
  const raw: J[] = []
  const model: J[] = []
  for (const b of m.blocks) {
    if (b.type === 'text') {
      raw.push({ type: 'text', text: b.text })
      model.push({ type: 'text', text: b.model_text ?? b.text })
    } else if (b.type === 'attachment' && !textOnly) {
      const img = image(b, ctx)
      if (img) raw.push(img), model.push(img)
      else if (b.ref) ctx.drop('attachment')
    } else if (b.type === 'harness' && b.model_visible && b.fallback_text) {
      raw.push({ type: 'text', text: b.fallback_text })
      model.push({ type: 'text', text: b.fallback_text })
    }
  }
  return { raw, model }
}

/** An assistant message and its tool results under entry id `id`. A layout copy (`copy`) gets fresh result entry ids. */
function writeAssistant(m: SessionLogMessage, id: string, seq: number, chain: Chain, ctx: Ctx, copy = false): void {
  const content: J[] = []
  const results: J[] = []
  const edits: J[] = []
  for (const b of m.blocks) {
    const data = piData(b as { ext?: J })
    if (b.type === 'text' && !b.synthetic) {
      content.push({ type: 'text', text: b.model_text ?? b.text, ...(data.textSignature ? { textSignature: data.textSignature } : {}) })
    } else if (b.type === 'reasoning') {
      content.push({ type: 'thinking', thinking: b.text, ...(data.thinkingSignature ? { thinkingSignature: data.thinkingSignature } : {}), ...(b.redacted ? { redacted: true } : {}) })
    } else if (b.type === 'harness' && b.model_visible && b.fallback_text) {
      content.push({ type: 'text', text: b.fallback_text })
    } else if (b.type === 'tool_call') {
      const input = b.input
      const args = typeof input === 'string' ? { input } : input && typeof input === 'object' && !Array.isArray(input) ? input : {}
      if (args !== input && typeof input !== 'string') ctx.drop('tool_input')
      content.push({ type: 'toolCall', id: b.call_id, name: b.name, arguments: args, ...(data.thoughtSignature ? { thoughtSignature: data.thoughtSignature } : {}) })
      const r = b.result
      if (!r) continue
      const closure = r.synthetic && r.is_error && !r.model_content && r.content.length === 1 && r.content[0]!.type === 'text' && r.content[0]!.text === PI_NO_RESULT
      if (closure) continue
      const rid = (!copy && (b.ext?.[PI]?.native_id as string | undefined)) || `${id}.r${results.length}`
      const at = b.ended_at ?? m.completed_at ?? m.created_at
      results.push({
        type: 'message', id: rid, timestamp: at,
        message: { role: 'toolResult', toolCallId: b.call_id, toolName: b.name, content: resultContent(r.content, ctx, !r.model_content), ...(data.details !== undefined ? { details: data.details } : {}), isError: r.is_error, timestamp: ms(at) },
      })
      if (r.model_content) edits.push({ type: 'context_edit', id: `${rid}.edit`, timestamp: r.cleared_at ?? at, targetId: rid, replacement: { content: resultContent(r.model_content, ctx, true) } })
    }
  }
  const calls = content.some((c) => c.type === 'toolCall')
  let stopReason = (m.finish && STOP[m.finish]) || (m.status === 'error' ? 'error' : m.status === 'aborted' || m.status === 'interrupted' ? 'aborted' : calls ? 'toolUse' : 'stop')
  const failed = stopReason === 'error' || stopReason === 'aborted'
  if (m.in_context && failed) stopReason = calls ? 'toolUse' : 'stop'
  chain.push({
    type: 'message', id, timestamp: m.created_at,
    message: {
      role: 'assistant', content,
      // A log without `api` (v1, OpenCode-converted) names a gateway model by provider and model, as modelView
      // compares them: give it the dialect every pi gateway model uses (model.ts), so pi-ai sees the same model.
      ...(m.model?.api ? { api: API[m.model.api] ?? m.model.api } : m.model?.provider === 'kortix' ? { api: 'openai-completions' } : {}),
      provider: m.model?.provider ?? 'unknown', model: m.model?.model ?? 'unknown',
      usage: piUsage(m.usage), stopReason,
      ...(m.error ? { errorMessage: m.error.message } : {}),
      timestamp: ms(m.created_at),
    },
  }, { id: m.message_id, seq })
  for (const r of results) chain.push(r)
  for (const e of edits) chain.push(e)
  if (!m.in_context) {
    if (!failed) chain.hide(id, m.created_at)
    for (const r of results) chain.hide(r.id, m.created_at)
  }
}

/** One thread as pi entries. `nextSeq` numbers the entries a layout compaction renders, above `floor`. */
function writeThread(thread: SessionLogThread, images: Ctx['images'], drop: Ctx['drop'], floor: number): Chain {
  const chain = new Chain()
  const visible = visibleMessageIds(thread)
  let current = ''
  const ctx: Ctx = { images, drop: (kind) => void (visible.has(current) && drop(kind)) }
  const msgs = [...thread.messages].sort((a, b) => a.seq - b.seq)
  const byId = new Map(msgs.map((m) => [m.message_id, m]))
  let nextSeq = Math.max(floor, ...msgs.map((m) => m.seq))
  /** Message id → its entry id, for a cut point. */
  const entryOf = new Map<string, string>()
  // A pi compaction names its first kept entry; keep that id so the record's ext round-trips.
  const named = new Map<string, string>()
  for (const m of msgs) {
    const c = m.blocks.find((b): b is CompactionBlock => b.type === 'compaction')
    const kept = piData(m).firstKeptEntryId
    if (c?.first_kept_message_id && typeof kept === 'string') named.set(c.first_kept_message_id, kept)
  }

  msgs.forEach((m, idx) => {
    current = m.message_id
    const id = named.get(m.message_id) ?? m.message_id
    const record = { id: m.message_id, seq: m.seq }
    if (m.kind === 'context' || m.role === 'system') return
    if (m.kind === 'compaction') {
      const block = m.blocks.find((b): b is CompactionBlock => b.type === 'compaction')
      if (!block || !m.in_context) return
      const native = (m.ext?.[PI]?.native_id as string | undefined) ?? id
      const k = block.first_kept_message_id ? msgs.findIndex((x) => x.message_id === block.first_kept_message_id) : -1
      if (!block.layout && block.summary !== null) {
        const firstKept = k < 0 ? native : msgs.slice(k, idx).map((x) => entryOf.get(x.message_id)).find(Boolean) ?? native
        const data = piData(m)
        chain.push({
          type: 'compaction', id: native, timestamp: m.created_at, summary: block.summary, firstKeptEntryId: firstKept, tokensBefore: block.tokens_before ?? 0,
          ...(m.usage ? { usage: piUsage(m.usage) } : {}), ...(data.details !== undefined ? { details: data.details } : {}), ...(data.fromHook ? { fromHook: true } : {}),
        }, record)
        entryOf.set(m.message_id, native)
        return
      }
      // A layout pi cannot express natively: hide what came before, render the layout in order.
      const layout = block.layout ?? [
        ...(block.summary !== null ? [{ summary: true as const }] : []),
        ...(k < 0 ? [] : msgs.slice(k, idx).filter((x) => x.in_context && x.kind === 'turn').map((x) => ({ message_id: x.message_id }))),
      ]
      for (const target of chain.visible.slice()) chain.hide(target, m.created_at)
      chain.push({ type: 'custom', id: native, customType: 'kortix.compaction', timestamp: m.created_at, data: { message_id: m.message_id } })
      layout.forEach((entry, i) => {
        const lid = `${native}.L${i}`
        const render = (content: string | J[]) => chain.push({ type: 'custom_message', id: lid, customType: 'kortix.compaction.layout', timestamp: m.created_at, content, display: true }, { id: `pi:${lid}`, seq: ++nextSeq })
        if ('summary' in entry) {
          if (block.summary) render(SUMMARY_PREFIX + block.summary + SUMMARY_SUFFIX)
        } else if ('text' in entry) render(entry.text)
        else {
          const kept = byId.get(entry.message_id)
          current = entry.message_id
          if (kept?.role === 'user') render(userContent(kept, ctx, 'text_only' in entry && entry.text_only).model)
          else if (kept?.role === 'assistant') writeAssistant({ ...kept, in_context: true, message_id: `pi:${lid}` }, lid, ++nextSeq, chain, ctx, true)
        }
      })
      return
    }
    if (m.role === 'user') {
      const { raw, model } = userContent(m, ctx)
      if (m.origin === 'automation') chain.push({ type: 'custom_message', id, customType: 'kortix.restored', timestamp: m.created_at, content: raw, display: true }, record)
      else chain.push({ type: 'message', id, timestamp: m.created_at, message: { role: 'user', content: raw, timestamp: ms(m.created_at) } }, record)
      if (JSON.stringify(raw) !== JSON.stringify(model)) chain.push({ type: 'context_edit', id: `${id}.edit`, timestamp: m.created_at, targetId: id, replacement: { content: model } })
      if (!m.in_context) chain.hide(id, m.created_at)
      entryOf.set(m.message_id, id)
      return
    }
    if (m.role === 'assistant') {
      writeAssistant(m, id, m.seq, chain, ctx)
      entryOf.set(m.message_id, id)
    }
  })
  chain.floor = nextSeq
  return chain
}

/** Each thread's v1 transcript, under the thread's pi id. */
function transcripts(log: SessionLog): Map<string, KortixMessage[]> {
  const threadOf = new Map(log.threads.flatMap((t) => t.messages.map((m) => [m.message_id, t.thread_id])))
  const out = new Map<string, KortixMessage[]>(log.threads.map((t) => [t.thread_id, []]))
  const blocks = new Map(log.threads.flatMap((t) => t.messages.map((m) => [m.message_id, m.blocks])))
  for (const row of toV1(log).rows) {
    const info = row.info as J
    const owner = String(info.id).replace(/-summary$/, '')
    const sessionID = threadOf.get(owner)
    if (!sessionID) continue
    info.sessionID = sessionID
    if (info.agent === '') delete info.agent
    const parts: J[] = (row.parts as J[]).map((p) => ({ ...p, sessionID }))
    // A file pi never received (session-log.ts): its v1 part, so the next export finds it again.
    for (const b of blocks.get(String(info.id)) ?? []) {
      if (b.type === 'harness' && b.harness === PI && b.kind === 'undelivered_file') {
        const d = (b.data ?? {}) as J
        parts.push({ id: b.id, sessionID, messageID: info.id, type: 'file', mime: d.mime, ...(d.filename ? { filename: d.filename } : {}), url: typeof d.url === 'string' ? d.url : '' })
      }
    }
    out.get(sessionID)!.push({ info, parts } as unknown as KortixMessage)
  }
  return out
}

/** The last context record the restore does not write: pi's rebuilt system prompt takes its id (`PiDump.contextId`). */
function contextOf(thread: SessionLogThread): { contextId?: string } {
  const last = thread.messages.filter((m) => m.kind === 'context').sort((a, b) => a.seq - b.seq).at(-1)
  return last ? { contextId: last.message_id } : {}
}

/** `seqMax`: the highest seq the API holds per thread, tombstones included (P6.1 `seq_max`). */
export async function restorePiSessionLog(input: SessionLog, target: PiRestoreTarget, seqMax: Readonly<Record<string, number>> = {}): Promise<SessionLogRestoreResult> {
  const log = structuredClone(input)
  const root = log.threads.find((t) => t.parent_thread_id === null) ?? log.threads[0]
  if (!root) throw new Error('session log has no thread')
  const rootId = root.thread_id
  // Another parentless thread (an old root another harness kept) hangs under the root; none is the root itself.
  for (const t of log.threads) if (t !== root && t.parent_thread_id === null) t.parent_thread_id = rootId
  log.threads = log.threads.filter((t) => t === root || t.thread_id !== rootId)
  const dropped: Record<string, number> = {}
  const images = new Map([...(await attachmentBytes(log, target.readAttachment))].map(([ref, bytes]) => [ref, bytes?.toString('base64') ?? null]))
  const drop = (kind: string) => void (dropped[kind] = (dropped[kind] ?? 0) + 1)
  const v1 = transcripts(log)

  const main = writeThread(root, images, drop, seqMax[rootId] ?? 0)
  if (main.floor > Math.max(0, ...Object.values(main.seqs))) {
    main.push({ type: 'custom', id: 'kortix-seq-floor', customType: 'kortix.seq-floor', timestamp: log.created_at, data: { seq: main.floor } })
    main.seqs['kortix-seq-floor'] = main.floor
  }
  const rootData = piData(root)
  const header = { type: 'session', version: rootData.header_version ?? 3, id: (root.ext?.[PI]?.native_id as string | undefined) ?? rootId, timestamp: log.created_at, cwd: rootData.cwd ?? target.cwd }
  const children = log.threads.filter((t) => t !== root).map((t): PiChildDump => {
    const chain = writeThread(t, images, drop, seqMax[t.thread_id] ?? 0)
    const agentMessages: J[] = []
    const messageIds: Array<string | null> = []
    const seqs: number[] = []
    let seq = 0
    for (const { sourceEntry, messages } of buildSessionProjection(chain.entries as SessionEntry[]).entries) {
      for (const message of messages) {
        const record = message.role !== 'toolResult' ? chain.ids[sourceEntry.id] : undefined
        if (record) seq = chain.seqs[sourceEntry.id]!
        agentMessages.push(message)
        messageIds.push(record ?? null)
        seqs.push(seq)
      }
    }
    const createdAt = ms(t.created_at)
    return {
      id: t.thread_id, title: t.title ?? '', agentName: t.agent ?? 'general', createdAt, updatedAt: Math.max(createdAt, ...t.messages.map((m) => ms(m.completed_at ?? m.created_at))),
      agentMessages: agentMessages as never, messageIds, seqs, nextSeq: chain.floor + 1, transcript: v1.get(t.thread_id) ?? [], ...contextOf(t),
    }
  })
  const dump: PiDump = {
    version: 1, rootId, title: log.title ?? '', createdAt: ms(log.created_at), agentMessages: [],
    entries: main.entries as never, header: header as never, messageIds: main.ids, seqs: main.seqs,
    transcript: v1.get(rootId) ?? [], turns: [], children, ...contextOf(root),
  }
  mkdirSync(target.stateDir, { recursive: true, mode: 0o700 })
  const path = piDumpPath(target.stateDir, target.sessionId)
  writeFileSync(`${path}.tmp`, JSON.stringify(dump), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)

  const { log: written, hashes } = piSessionLog(readPiSnapshot(target.stateDir, target.sessionId, log.selection)!)
  const cursors = written.threads.map((t): ExportCursor => ({
    thread_id: t.thread_id,
    last_seq: Math.max(-1, ...t.messages.map((m) => m.seq)),
    native_hashes: Object.fromEntries(t.messages.map((m) => [m.message_id, hashes.get(m.message_id)!])),
  }))
  if (Object.keys(dropped).length) logger.warn('[session-log] restore could not write all model-visible content', { dropped })
  return { cursors, dropped }
}

/**
 * The store at `stateDir` as `PiRuntime.sessionLogSnapshot()` reads it after a start, at rest.
 * The session's agent and model come from the runtime's config, so they are passed in.
 */
export function readPiSnapshot(stateDir: string, sessionId: string, selection?: SessionLog['selection']): PiSessionSnapshot | null {
  let dump: PiDump
  try {
    dump = JSON.parse(readFileSync(piDumpPath(stateDir, sessionId), 'utf8')) as PiDump
  } catch {
    return null
  }
  const entries = dump.entries ?? []
  return {
    sessionId, rootId: dump.rootId, title: dump.title, header: dump.header ?? null, entries, leafId: entries.at(-1)?.id ?? null,
    entryMessageIds: dump.messageIds ?? {}, entrySeqs: dump.seqs, transcript: dump.transcript,
    children: (dump.children ?? []).map((c) => {
      const seqs = c.seqs ?? c.agentMessages.map((_, i) => i + 1)
      return {
        id: c.id, title: c.title, agentName: c.agentName, createdAt: c.createdAt, agentMessages: c.agentMessages,
        messageIds: c.messageIds ?? c.agentMessages.map(() => null), seqs, nextSeq: Math.max(c.nextSeq ?? 0, Math.max(0, ...seqs) + 1), reply: null, transcript: c.transcript, busy: false,
      }
    }),
    busy: false, reply: null,
    agent: selection?.agent ?? null,
    model: selection?.model ? { provider: selection.model.provider, model: selection.model.model } : null,
  }
}
