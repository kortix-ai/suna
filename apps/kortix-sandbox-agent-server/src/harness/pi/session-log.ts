/**
 * The pi session-log adapter (P2.5): pi's native store as `kortix.session/2`
 * minor 1 records (`@kortix/api-contract/session-log`; the rules are in the
 * header of its `types.ts`). `boot.ts` hands it to the journal.
 *
 * What it reads (`PiSessionSnapshot`, built by `PiRuntime.sessionLogSnapshot`):
 * the root's `SessionManager` branch, its session header (which `getEntries()`
 * leaves out), each sub-agent child's `AgentMessage[]` (a child has no
 * entries), and the Kortix v1 transcript of each. pi holds the model-visible
 * content. The transcript holds the Kortix ids: pi entries carry pi's own ids,
 * so the runtime records which Kortix message each pi message is
 * (`entryMessageIds`, child `messageIds`), and block ids are the v1 part ids
 * (`<mid>-p<n>`), matched by part type and order. A message or block with no
 * Kortix id gets a position-derived one (`pi:<entry id>`, `<mid>-n<index>`).
 *
 * Mapping decisions:
 * - The model of an assistant message is the one the pi message names. A v1
 *   assistant row carries the model selected when it streamed.
 * - User text: `text` is the v1 text, `model_text` the text pi sent when it
 *   differs (a prompt template pi expanded). A pi image is an attachment with
 *   `ref: blob:<sha256>` and `bytes`; the bytes stay in the native store (no
 *   object store yet). A v1 file part pi never received (not an image, a
 *   model without image input, or an image pi dropped) is a harness block
 *   `{ kind: 'undelivered_file', model_visible: false }`, never an
 *   attachment: the model never saw it, so a restore must not present it.
 * - Reasoning is display only (C3); its signature stays in `ext.pi`.
 * - A call with no result, at rest, is closed (C2/F11) with pi-ai's own text.
 * - An errored or aborted reply is out of context: pi-ai never replays one.
 *   A context edit with no replacement takes a message out of context
 *   (`failed_attempt` for a reply, `retracted` for a user message).
 * - A compaction entry is a `compaction` message with the marker's ids and
 *   `first_kept_message_id` from pi's `firstKeptEntryId`.
 * - A sub-agent child is a thread with `parent_thread_id` and `spawned_by` =
 *   the root `task` call whose result names it.
 * - `native_hash` digests the pi entries (or child messages) a record is built
 *   from, its v1 message, its seq and whether it streams.
 *
 * The seq rule. `seq` is monotonic per thread and never reused: the API keeps
 * a tombstoned row with its seq and rejects a second row on the same
 * (session, thread, seq). A root message's seq is its entry's position in
 * pi's append-only entry list (`getEntries()`, 1-based), not its position
 * among the messages of the active branch: a branch switch or a hidden
 * message never moves a seq, and a later entry always gets a higher one. A
 * child has no entries and pi's retry drops a failed message and appends its
 * replacement at the same index, so the runtime issues each child message a
 * seq once (`seqs`) and never issues it again. Seqs have gaps.
 */
import { createHash } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent'
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  type AdapterCapabilities,
  type CapabilityFeatures,
  type ExportCursor,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogSessionPatch,
  type SessionLogThread,
  type ToolCallBlock,
  type ToolResultContent,
} from '@kortix/api-contract/session-log'
import type { KortixMessage, KortixPart } from '@kortix/api-contract/transcript'
import type { ExportedMessage, SessionLogChanges, SessionLogPort } from '../contract/session-log'
import { assistantMessageError } from './turn-events'
import { PI_HARNESS_VERSION } from './version'

export interface PiChildSnapshot {
  id: string
  title: string
  agentName: string
  createdAt: number
  agentMessages: AgentMessage[]
  /** The Kortix message id of each agent message, by index; null when unknown. */
  messageIds: Array<string | null>
  /** The seq of each agent message, by index: issued once, never reused (see the seq rule). */
  seqs: number[]
  transcript: KortixMessage[]
  /** A prompt runs in the child now. */
  busy: boolean
}

export interface PiSessionSnapshot {
  /** The Kortix session id. */
  sessionId: string
  rootId: string
  title: string
  header: SessionHeader | null
  /** Every entry, in append order (`SessionManager.getEntries()`). */
  entries: SessionEntry[]
  /** The active branch ends here (`SessionManager.getLeafId()`). */
  leafId: string | null
  /** pi entry id → Kortix message id. */
  entryMessageIds: Record<string, string>
  transcript: KortixMessage[]
  children: PiChildSnapshot[]
  /** A root turn runs now. */
  busy: boolean
  agent: string | null
  model: { provider: string; model: string } | null
}

export const PI_VERSION = PI_HARNESS_VERSION.split('@').pop() ?? PI_HARNESS_VERSION
export const PI_ADAPTER_VERSION = '1.0.0'
const PRODUCER = { harness: 'pi', harness_version: PI_VERSION, adapter_version: PI_ADAPTER_VERSION }
const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const
/** What pi-ai sends for a call whose result is missing. */
export const PI_NO_RESULT = 'No result provided'
const DIALECT: Record<string, string> = { 'openai-completions': 'openai-chat', 'openai-responses': 'openai-responses', 'anthropic-messages': 'anthropic-messages' }
const KIND: Record<string, string> = { bash: 'shell', read: 'read', write: 'write', edit: 'edit', glob: 'glob', grep: 'grep', task: 'task', question: 'question', web_search: 'web_search' }

const native: CapabilityFeatures = {
  tool_error_channel: false, // openai-chat role:tool has no is_error
  attachments: { user: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], tool_result: false },
  compaction: ['summary_first_tail'],
  subagents: 'sync', // the Kortix `task` tool runs a child agent in process
  todos: false,
  reasoning_replay: 'lowers_to_text', // pi-ai replays another model's thinking as text
  freeform_tool_input: false,
}
/** Tested in the prototype adapter; restore lands in P6. */
export const PI_CAPABILITIES: AdapterCapabilities = {
  harness: 'pi',
  harness_versions: PI_VERSION,
  schema_minors: [SESSION_LOG_MINOR],
  dialects: ['openai-chat'],
  native,
  // A tool-result image becomes a follow-up user turn; a layout compaction is rendered as entries.
  rendered: { ...native, attachments: { ...native.attachments, tool_result: true }, compaction: ['summary_first_tail', 'layout'] },
}

// ── native shapes (pi's types are wider than what this reads) ─────────────
type J = Record<string, any>
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const iso = (ms: unknown): string => new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : 0).toISOString()
const isoOf = (value: unknown): string => (typeof value === 'string' ? value : iso(value))

/** Takes v1 parts of one message in order, by type. */
function partPool(v1: KortixMessage | undefined) {
  const parts = [...(v1?.parts ?? [])] as J[]
  return {
    take(type: string, match: (part: J) => boolean = () => true): J | undefined {
      const i = parts.findIndex((p) => p.type === type && match(p))
      return i < 0 ? undefined : parts.splice(i, 1)[0]
    },
    rest: (type: string) => parts.filter((p) => p.type === type),
  }
}

function attachment(c: J): { ref: string; bytes: number; sha256: string; mime: string } {
  const bytes = Buffer.from(String(c.data ?? ''), 'base64')
  const digest = sha256(bytes)
  return { ref: `blob:${digest}`, bytes: bytes.length, sha256: digest, mime: String(c.mimeType ?? 'application/octet-stream') }
}

function resultContent(content: unknown): ToolResultContent[] {
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as J[]) : []
  return items.flatMap((c): ToolResultContent[] => {
    if (c.type === 'text') return [{ type: 'text', text: String(c.text ?? '') }]
    if (c.type === 'image') {
      const a = attachment(c)
      return [{ type: 'attachment', ref: a.ref, mime: a.mime, sha256: a.sha256 }]
    }
    return []
  })
}

const textOf = (content: ToolResultContent[]) => content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')

function message(threadId: string, id: string, role: SessionLogMessage['role'], created: string): SessionLogMessage {
  return {
    ...V, message_id: id, thread_id: threadId, seq: 0, role, kind: 'turn', status: 'complete', in_context: true,
    model: null, usage: null, finish: null, error: null, created_at: created, completed_at: created, producer: PRODUCER, blocks: [],
  }
}

function v1Model(v1: KortixMessage | undefined) {
  const model = (v1?.info as J | undefined)?.model
  return model?.providerID && model?.modelID ? { provider: model.providerID, model: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } : null
}

const FINISH: Record<string, SessionLogMessage['finish']> = { stop: 'stop', toolUse: 'tool_calls', length: 'length', error: 'error', aborted: 'aborted' }

type Derived = { message: SessionLogMessage; native: unknown[] }

/**
 * One thread's messages, in order. `entries` is a pi branch; a child's
 * messages come in as plain message entries.
 */
function deriveThread(input: {
  threadId: string
  entries: J[]
  ids: (entry: J) => string | undefined
  transcript: KortixMessage[]
  busy: boolean
  child: boolean
  seqOf: (entry: J) => number
}): Derived[] {
  const { threadId, entries } = input
  const v1 = new Map(input.transcript.map((m) => [m.info.id as string, m]))
  const results = new Map<string, J>()
  const edits = new Map<string, J[]>()
  for (const e of entries) {
    if (e.type === 'message' && e.message?.role === 'toolResult') results.set(e.message.toolCallId, e)
    if (e.type === 'context_edit') edits.set(e.targetId, [...(edits.get(e.targetId) ?? []), e])
  }
  const idOf = (e: J) => input.ids(e) ?? `pi:${e.id}`
  const lastAssistant = entries.findLast((e) => e.type === 'message' && e.message?.role === 'assistant')
  const out: Derived[] = []

  for (const e of entries) {
    const own = edits.get(e.id) ?? []
    const latest = own.at(-1)
    const replacement = own.findLast((x) => x.replacement !== null)?.replacement
    const msg: J | undefined = e.type === 'message' ? e.message : e.type === 'custom_message' ? { role: 'custom', ...e } : undefined

    if (e.type === 'compaction') {
      const id = idOf(e)
      const marker = v1.get(id)
      const part = partPool(marker).take('compaction')
      const m = message(threadId, id, 'user', isoOf(e.timestamp))
      m.kind = 'compaction'
      m.usage = usageOf(e.usage)
      m.blocks = [{
        type: 'compaction',
        id: (part?.id as string | undefined) ?? `${id}-n0`,
        summary: e.summary,
        first_kept_message_id: firstKept(entries, e, idOf),
        tokens_before: e.tokensBefore,
        ...(part ? { trigger: part.overflow ? 'overflow' : part.auto ? 'auto' : 'manual' } : {}),
      }]
      m.ext = { pi: { version: PI_VERSION, native_id: e.id, data: { firstKeptEntryId: e.firstKeptEntryId, ...(e.details !== undefined ? { details: e.details } : {}), ...(e.fromHook ? { fromHook: true } : {}) } } }
      out.push({ message: m, native: [e, marker ?? null] })
      continue
    }
    if (!msg || msg.role === 'toolResult') continue

    const id = idOf(e)
    const row = v1.get(id)
    const pool = partPool(row)
    const blockId = (type: string, index: number, match?: (part: J) => boolean) => (pool.take(type, match)?.id as string | undefined) ?? `${id}-n${index}`
    const nativeParts: unknown[] = [e, ...own, row ?? null]

    if (msg.role === 'user' || msg.role === 'custom' || msg.role === 'system') {
      const m = message(threadId, id, msg.role === 'system' ? 'system' : 'user', iso(msg.timestamp))
      if (msg.role === 'system') m.kind = 'context'
      if (msg.role === 'custom') m.origin = 'automation'
      if (input.child && msg.role === 'user' && !out.some((x) => x.message.role === 'user')) m.origin = 'subagent'
      m.model = v1Model(row)
      if (typeof row?.info.agent === 'string') m.agent = row.info.agent
      // pi 1.0 keeps the system prompt as a message whose text is in `sections`.
      const system = msg.role === 'system' ? [typeof msg.content === 'string' ? msg.content : '', ...Object.values(msg.sections ?? {})].filter((x) => typeof x === 'string' && x).join('\n\n') : null
      const content: J[] = system !== null ? [{ type: 'text', text: system }] : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content ?? [])
      const sent: J[] | undefined = replacement ? (typeof replacement.content === 'string' ? [{ type: 'text', text: replacement.content }] : replacement.content) : undefined
      content.forEach((c, i) => {
        if (c.type === 'text') {
          const part = pool.take('text')
          const display = typeof part?.text === 'string' ? part.text : c.text
          const modelText = sent ? (sent[i]?.type === 'text' ? sent[i].text : '') : c.text
          m.blocks.push({ type: 'text', id: (part?.id as string | undefined) ?? `${id}-n${i}`, text: display, ...(modelText !== display ? { model_text: modelText } : {}) })
        } else if (c.type === 'image') {
          const part = pool.take('file', (p) => String(p.mime).startsWith('image/'))
          m.blocks.push({ type: 'attachment', id: (part?.id as string | undefined) ?? `${id}-n${i}`, ...attachment(c), ...(part?.filename ? { name: part.filename } : {}) })
        }
      })
      // A file pi never received: a harness block, never an attachment, so a restore does not present it to the model.
      for (const part of pool.rest('file')) {
        const url = String(part.url ?? '')
        const data = url.startsWith('data:') ? { mime: part.mime, filename: part.filename, bytes: Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').length } : { mime: part.mime, filename: part.filename, url }
        m.blocks.push({ type: 'harness', id: part.id as string, harness: 'pi', kind: 'undelivered_file', data, model_visible: false })
      }
      if (latest && latest.replacement === null) {
        m.in_context = false
        m.hidden_reason = 'retracted'
      }
      out.push({ message: m, native: nativeParts })
      continue
    }

    if (msg.role !== 'assistant') continue
    const m = message(threadId, id, 'assistant', iso(msg.timestamp))
    m.model = { provider: msg.provider, model: msg.model, ...(DIALECT[msg.api] ? { api: DIALECT[msg.api] } : msg.api ? { api: msg.api } : {}) }
    m.usage = usageOf(msg.usage)
    m.finish = FINISH[msg.stopReason] ?? null
    if (typeof row?.info.agent === 'string') m.agent = row.info.agent
    const parent = (row?.info as J | undefined)?.parentID
    if (typeof parent === 'string') m.reply_to = parent
    m.completed_at = typeof (row?.info as J | undefined)?.time?.completed === 'number' ? iso((row!.info as J).time.completed) : m.created_at
    const failure = assistantMessageError(msg as never)
    if (failure) {
      const data = failure.data as { message?: string } | undefined
      m.error = { code: failure.code ?? failure.name, message: data?.message ?? msg.errorMessage ?? '' }
    }
    if (msg.stopReason === 'error') m.status = 'error'
    if (msg.stopReason === 'aborted') m.status = 'aborted'
    if (latest && latest.replacement === null) {
      m.in_context = false
      m.hidden_reason = 'failed_attempt'
    } else if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
      m.in_context = false
      m.hidden_reason = msg.stopReason === 'aborted' ? 'aborted' : 'failed_attempt'
    }
    const streaming = input.busy && e === lastAssistant
    let open = false
    ;(msg.content ?? []).forEach((c: J, i: number) => {
      if (c.type === 'text') {
        m.blocks.push({ type: 'text', id: blockId('text', i), text: c.text ?? '', ...(c.textSignature ? { ext: { pi: { version: PI_VERSION, data: { textSignature: c.textSignature } } } } : {}) })
      } else if (c.type === 'thinking') {
        const signed = c.thinkingSignature || c.redacted
        m.blocks.push({ type: 'reasoning', id: blockId('reasoning', i), text: c.thinking ?? '', ...(c.redacted ? { redacted: true } : {}), ...(signed ? { ext: { pi: { version: PI_VERSION, data: { thinkingSignature: c.thinkingSignature } } } } : {}) })
      } else if (c.type === 'toolCall') {
        const part = pool.take('tool', (p) => p.tool === c.name)
        const block = toolCall(c, part, results.get(c.id), edits, `${id}-n${i}`)
        if (!block.result) {
          if (streaming) block.status = 'running'
          else close(block)
          open ||= streaming
        }
        const r = results.get(c.id)
        if (r) nativeParts.push(r, ...(edits.get(r.id) ?? []))
        m.blocks.push(block)
      }
    })
    if (open) {
      m.status = 'streaming'
      m.completed_at = null
    }
    out.push({ message: m, native: [...nativeParts, open] })
  }
  for (const d of out) d.message.seq = input.seqOf(d.native[0] as J)
  return out
}

function usageOf(u: J | undefined) {
  return u ? { input: u.input ?? 0, output: u.output ?? 0, cache_read: u.cacheRead ?? 0, cache_write: u.cacheWrite ?? 0, ...(u.cost?.total ? { cost: u.cost.total } : {}) } : null
}

/** The message pi keeps from: the first message entry at or after `firstKeptEntryId`, before the compaction. */
function firstKept(entries: J[], c: J, idOf: (e: J) => string): string | null {
  const start = entries.findIndex((e) => e.id === c.firstKeptEntryId)
  const end = entries.indexOf(c)
  if (start < 0 || start >= end) return null
  for (const e of entries.slice(start, end)) {
    if ((e.type === 'message' && e.message?.role !== 'toolResult') || e.type === 'custom_message' || e.type === 'compaction') return idOf(e)
  }
  return null
}

function toolCall(c: J, part: J | undefined, result: J | undefined, edits: Map<string, J[]>, fallbackId: string): ToolCallBlock {
  const time = part?.state?.time as { start?: number; end?: number } | undefined
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: (part?.id as string | undefined) ?? fallbackId,
    call_id: c.id,
    name: c.name,
    kind: KIND[c.name] ?? (c.name.includes('__') || c.name.startsWith('mcp_') ? 'mcp' : 'other'),
    input: c.arguments,
    status: 'pending',
    ...(time?.start ? { started_at: iso(time.start) } : {}),
  }
  if (c.thoughtSignature) block.ext = { pi: { version: PI_VERSION, data: { thoughtSignature: c.thoughtSignature } } }
  if (!result) return block
  const r = result.message as J
  const content = resultContent(r.content)
  block.status = r.isError ? 'error' : 'complete'
  block.ended_at = time?.end ? iso(time.end) : iso(r.timestamp)
  block.result = { content, is_error: r.isError === true, ...(r.isError ? { error: { message: textOf(content) } } : {}) }
  const edit = edits.get(result.id)?.at(-1)
  if (edit) {
    // What pi sends for a pruned result: its replacement, or pi-ai's "No result provided" for none.
    block.result.model_content = edit.replacement === null ? [{ type: 'text', text: PI_NO_RESULT }] : resultContent(edit.replacement.content)
    block.result.cleared_at = isoOf(edit.timestamp)
  }
  if (r.details !== undefined) block.ext = { pi: { version: PI_VERSION, native_id: result.id, data: { ...((block.ext?.pi?.data as J) ?? {}), details: r.details } } }
  return block
}

/** C2/F11: at rest, a call with no result is closed with the text pi-ai sends for it. */
function close(block: ToolCallBlock): void {
  block.status = 'error'
  block.result = { content: [{ type: 'text', text: PI_NO_RESULT }], is_error: true, synthetic: true, error: { code: 'interrupted', message: PI_NO_RESULT } }
}

/** The whole session as a log, and each message's native hash. */
export function piSessionLog(s: PiSessionSnapshot): { log: SessionLog; hashes: Map<string, string> } {
  const created = s.header?.timestamp ?? iso(0)
  const hashes = new Map<string, string>()
  const finish = (derived: Derived[]) =>
    derived.map(({ message, native }) => {
      hashes.set(message.message_id, sha256(JSON.stringify([message.seq, native])))
      return message
    })
  const all = s.entries as J[]
  const position = new Map(all.map((e, i) => [e.id as string, i + 1]))
  const rootMessages = finish(deriveThread({ threadId: s.rootId, entries: activeBranch(all, s.leafId), ids: (e) => s.entryMessageIds[e.id], transcript: s.transcript, busy: s.busy, child: false, seqOf: (e) => position.get(e.id)! }))
  const root: SessionLogThread = {
    ...V, thread_id: s.rootId, parent_thread_id: null, spawned_by: null, agent: s.agent, title: s.title, created_at: created, messages: rootMessages,
    ...(s.header ? { ext: { pi: { version: PI_VERSION, native_id: s.header.id, data: { cwd: s.header.cwd, header_version: s.header.version ?? null } } } } : {}),
  }
  const children = s.children.map((child): SessionLogThread => {
    const entries = child.agentMessages.map((m, i) => ({ type: 'message', id: `${child.id}:s${child.seqs[i]}`, index: i, message: m }))
    const messages = finish(deriveThread({ threadId: child.id, entries, ids: (e) => child.messageIds[e.index] ?? undefined, transcript: child.transcript, busy: child.busy, child: true, seqOf: (e) => child.seqs[e.index]! }))
    return { ...V, thread_id: child.id, parent_thread_id: s.rootId, spawned_by: spawnedBy(rootMessages, child.id), agent: child.agentName, title: child.title, created_at: iso(child.createdAt), messages }
  })
  const log: SessionLog = {
    ...V, session_id: s.sessionId, title: s.title, created_at: created, restore_grade: 'native',
    harness: { current: 'pi', history: [{ harness: 'pi', version: PI_VERSION, from_seq: 1, at: created }] },
    selection: { agent: s.agent, model: s.model },
    todos: [], pending: { questions: [], permissions: [] },
    threads: [root, ...children],
  }
  return { log, hashes }
}

/** The entries from the root to `leafId`, oldest first (`SessionManager.getBranch()`). */
function activeBranch(entries: J[], leafId: string | null): J[] {
  const byId = new Map(entries.map((e) => [e.id as string, e]))
  const path: J[] = []
  for (let e = leafId ? byId.get(leafId) : undefined; e; e = e.parentId ? byId.get(e.parentId) : undefined) path.push(e)
  return path.reverse()
}

/** The root `task` call whose result names the child (`details.sessionId`, else `task_id: <id>` in its text). */
function spawnedBy(messages: SessionLogMessage[], childId: string): SessionLogThread['spawned_by'] {
  for (const m of messages) {
    for (const b of m.blocks as SessionLogBlock[]) {
      if (b.type !== 'tool_call' || !b.result) continue
      const details = (b.ext?.pi?.data as J | undefined)?.details
      if (details?.sessionId === childId || textOf(b.result.content).includes(`task_id: ${childId}`)) return { message_id: m.message_id, call_id: b.call_id }
    }
  }
  return null
}

/** The session-log port over a live pi runtime. `read` returns null while the runtime is down. */
export function createPiSessionLogPort(read: () => PiSessionSnapshot | null): SessionLogPort {
  let lastSession: string | null = null
  return {
    capabilities: PI_CAPABILITIES,
    async changes(cursors: readonly ExportCursor[]): Promise<SessionLogChanges> {
      const s = read()
      if (!s) return { messages: [], tombstones: [], threads: [] }
      const { log, hashes } = piSessionLog(s)
      const byThread = new Map(cursors.map((c) => [c.thread_id, c]))
      const live = new Set(hashes.keys())
      const messages: ExportedMessage[] = []
      for (const thread of log.threads) {
        const cursor = byThread.get(thread.thread_id)
        for (const message of thread.messages) {
          const native_hash = hashes.get(message.message_id)!
          if (!cursor || message.seq > cursor.last_seq || cursor.native_hashes[message.message_id] !== native_hash) messages.push({ message, native_hash })
        }
      }
      const tombstones = cursors.flatMap((c) => Object.keys(c.native_hashes).filter((id) => !live.has(id)))
      const { threads, ...session } = log
      const json = JSON.stringify(session)
      const changed = json !== lastSession
      lastSession = json
      return {
        messages,
        tombstones,
        threads: threads.map(({ messages: _messages, ...thread }) => thread),
        ...(changed ? { session: session as SessionLogSessionPatch } : {}),
      }
    },
    /**
     * P6 writes `log` into pi's native store here (root entries with the
     * header, child agent messages, the v1 transcript and the id maps) before
     * the runtime starts, and returns one cursor per thread with the native
     * hash `piSessionLog` computes for each message written. Until then a box
     * restores nothing from the log: no cursors.
     */
    async restore(_log: SessionLog): Promise<ExportCursor[]> {
      return []
    },
    async fingerprint(): Promise<string> {
      const s = read()
      return sha256(JSON.stringify(s ? [s.header, s.entries, s.children.map((c) => c.agentMessages)] : null))
    },
  }
}
