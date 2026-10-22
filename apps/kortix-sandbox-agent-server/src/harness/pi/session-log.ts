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
 *   differs (a prompt template pi expanded). A pi image (a prompt's, or a tool
 *   result's) is an attachment with `ref: blob:<sha256>`, `sha256` and `bytes`;
 *   the journal uploads the bytes (`blob`) and replaces the ref with the stored
 *   object's `kortix-attachment://` ref (P2.13). A v1 file part pi never received (not an image, a
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
 * - `usage.reasoning` is pi's `usage.reasoning` when pi reports a number
 *   (pi-ai's OpenAI dialects always do, 0 without a breakdown) (P2.10).
 * - A call's `title` is its v1 part's `state.title` (pi's v1 sets the tool
 *   name on a completed call; an errored or open call has none) (P2.10).
 * - `created_at` is pi's own message timestamp (the compaction entry's time
 *   for a compaction), not the v1 `time.created`. pi-ai stamps an assistant
 *   message when it sends the model request; the runtime stamps the v1 row at
 *   pi's `message_start`, when the response starts. So a reply's `created_at`
 *   is earlier than its v1 row by the time to the response (P2 dev check on a
 *   real session: -3750..+16 ms). pi-ai stamps a child's initial system
 *   message 0: that context message gets the thread's `created_at` (P2.10).
 *   An assistant's `completed_at` is the v1 `time.completed`.
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
 *
 * A restored store (P6.2, `session-log-restore.ts`) keeps each record's seq:
 * the dump maps every entry the restore wrote to its seq (`entrySeqs`), and
 * an entry appended after it gets its position plus the largest
 * `seq - position` of a mapped entry, so it numbers above every restored seq.
 *
 * The live seq (P4.3b). pi appends a message's entry at its `message_end`, so
 * the reply it streams has no entry yet. pi's own listener appends every
 * earlier entry before the runtime sees the next event, and pi defers a custom
 * message while it streams: the reply's entry is the next one,
 * `getEntries().length + 1` (a child: its `nextSeq`). An extension that
 * appends a non-message entry (a custom entry, a label, a session name)
 * while the reply streams moves the reply one entry later: its turn-end
 * record then carries a higher seq than its streaming puts, and replaces
 * them (higher rev). A user message has no seq until pi appends its entry,
 * when its turn starts.
 */
import { createHash } from 'node:crypto'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SessionEntry, SessionHeader } from '@earendil-works/pi-coding-agent'
import {
  SESSION_LOG_MINOR,
  SESSION_LOG_SCHEMA,
  PI_CAPABILITIES,
  type ExportCursor,
  type SessionLog,
  type SessionLogBlock,
  type SessionLogMessage,
  type SessionLogThread,
  type ToolCallBlock,
  type ToolResultContent,
} from '@kortix/api-contract/session-log'
import type { KortixMessage, KortixPart } from '@kortix/api-contract/transcript'
import type { SessionLogChanges, SessionLogPort, SessionLogRestoreResult } from '../contract/session-log'
import { logChanges } from '../shared/session-log-journal'
import { isRestoreNote } from '../shared/session-log-boot'
import type { BytesReader } from '../shared/session-log-restore'
import { restorePiSessionLog, type PiRestoreTarget } from './session-log-restore'
import { assistantMessageError } from './turn-events'
import { PI_HARNESS_VERSION } from './version'
import { imageTagPaths } from './images'

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
  /** The seq the child's next message gets. */
  nextSeq: number
  /** The reply the child streams now: its Kortix id and pi timestamp. */
  reply: { id: string; timestamp: number } | null
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
  /** pi entry id → seq of each entry a restore wrote (the seq rule); absent or empty on a store never restored. */
  entrySeqs?: Record<string, number>
  transcript: KortixMessage[]
  children: PiChildSnapshot[]
  /** A root turn runs now. */
  busy: boolean
  /** The assistant message the root turn streams now: its Kortix id and pi timestamp. */
  reply: { id: string; timestamp: number } | null
  agent: string | null
  model: { provider: string; model: string } | null
}

export const PI_VERSION = PI_HARNESS_VERSION.split('@').pop() ?? PI_HARNESS_VERSION
export const PI_ADAPTER_VERSION = '1.1.0'
const PRODUCER = { harness: 'pi', harness_version: PI_VERSION, adapter_version: PI_ADAPTER_VERSION }
const V = { schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR } as const
/** What pi-ai sends for a call whose result is missing. */
export const PI_NO_RESULT = 'No result provided'
const DIALECT: Record<string, string> = { 'openai-completions': 'openai-chat', 'openai-responses': 'openai-responses', 'anthropic-messages': 'anthropic-messages' }
const KIND: Record<string, string> = { bash: 'shell', read: 'read', write: 'write', edit: 'edit', glob: 'glob', grep: 'grep', task: 'task', question: 'question', web_search: 'web_search', codemode: 'code' }
const toolKind = (name: string) => KIND[name] ?? (name.includes('__') || name.startsWith('mcp_') ? 'mcp' : 'other')

/**
 * A codemode script's tool calls, harness-neutral (`result.details.calls`): pi's bounded
 * `nestedCalls` record on the result message (256 calls, 8 kB of input each, 32 kB in all,
 * 500-character errors, no outputs). The model never saw them, so they are display data,
 * never tool_call blocks: a restore would present calls the model did not make.
 */
export type CodemodeCall = { call_id: string; name: string; kind: string; status: 'complete' | 'error' | 'interrupted'; input?: unknown; input_bytes?: number; duration_ms?: number; error?: string }
const NESTED_STATUS: Record<string, CodemodeCall['status']> = { ok: 'complete', error: 'error', unfinished: 'interrupted' }

export function codemodeDetails(nested: J): { calls: CodemodeCall[]; complete: boolean } {
  const calls = (Array.isArray(nested.calls) ? nested.calls : []).map((c: J): CodemodeCall => ({
    call_id: c.id,
    name: c.name,
    kind: toolKind(c.name),
    status: NESTED_STATUS[c.status] ?? 'interrupted',
    ...(c.arguments !== undefined ? { input: c.arguments } : {}),
    ...(typeof c.argumentsBytes === 'number' ? { input_bytes: c.argumentsBytes } : {}),
    ...(typeof c.durationMs === 'number' ? { duration_ms: c.durationMs } : {}),
    ...(typeof c.error === 'string' ? { error: c.error } : {}),
  }))
  return { calls, complete: nested.complete !== false }
}

/** The inverse of `codemodeDetails`: pi's `nestedCalls`, for a restore. */
export function piNestedCalls(details: { calls: CodemodeCall[]; complete: boolean }): J {
  const status = Object.fromEntries(Object.entries(NESTED_STATUS).map(([k, v]) => [v, k]))
  return {
    calls: details.calls.map((c) => ({
      id: c.call_id,
      name: c.name,
      status: status[c.status],
      ...(c.input !== undefined ? { arguments: c.input } : {}),
      ...(c.input_bytes !== undefined ? { argumentsBytes: c.input_bytes } : {}),
      ...(c.duration_ms !== undefined ? { durationMs: c.duration_ms } : {}),
      ...(c.error !== undefined ? { error: c.error } : {}),
    })),
    complete: details.complete,
  }
}

/** pi's `codemode-store` entries on a branch, folded: the values a script's `load()` reads. */
export function codemodeStore(branch: J[]): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  for (const e of branch) {
    if (e.type !== 'custom' || e.customType !== 'codemode-store') continue
    Object.assign(store, e.data?.set ?? {})
    for (const key of e.data?.delete ?? []) delete store[key]
  }
  return store
}

/** The manifest (C12, F9) lives in `@kortix/api-contract/session-log` (`capabilities.ts`): apps/api reads it for the switch preflight. */
export { PI_CAPABILITIES }

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

/** An image as an attachment; `images` collects its base64 data by sha256 (`SessionLogPort.blob`). */
function attachment(c: J, images: Map<string, string>): { ref: string; bytes: number; sha256: string; mime: string } {
  const data = String(c.data ?? '')
  const bytes = Buffer.from(data, 'base64')
  const digest = sha256(bytes)
  images.set(digest, data)
  return { ref: `blob:${digest}`, bytes: bytes.length, sha256: digest, mime: String(c.mimeType ?? 'application/octet-stream') }
}

function resultContent(content: unknown, images: Map<string, string>): ToolResultContent[] {
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as J[]) : []
  return items.flatMap((c): ToolResultContent[] => {
    if (c.type === 'text') return [{ type: 'text', text: String(c.text ?? '') }]
    if (c.type === 'image') {
      const a = attachment(c, images)
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
  /** The thread's creation (ms): the time of a message pi-ai stamps 0 (its initial system message). */
  createdAt: number
  images: Map<string, string>
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
      const m = message(threadId, id, msg.role === 'system' ? 'system' : 'user', iso(msg.timestamp || input.createdAt))
      if (msg.role === 'system') m.kind = 'context'
      if (msg.role === 'custom') m.origin = 'automation'
      if (input.child && msg.role === 'user' && !out.some((x) => x.message.role === 'user')) m.origin = 'subagent'
      m.model = v1Model(row)
      if (typeof row?.info.agent === 'string') m.agent = row.info.agent
      // pi 1.0 keeps the system prompt as a message whose text is in `sections`.
      const system = msg.role === 'system' ? [typeof msg.content === 'string' ? msg.content : '', ...Object.values(msg.sections ?? {})].filter((x) => typeof x === 'string' && x).join('\n\n') : null
      const content: J[] = system !== null ? [{ type: 'text', text: system }] : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content ?? [])
      const sent: J[] | undefined = replacement ? (typeof replacement.content === 'string' ? [{ type: 'text', text: replacement.content }] : replacement.content) : undefined
      const fromTags: J[] = []
      content.forEach((c, i) => {
        if (c.type === 'text') {
          const part = pool.take('text')
          const display = typeof part?.text === 'string' ? part.text : c.text
          const modelText = sent ? (sent[i]?.type === 'text' ? sent[i].text : '') : c.text
          // Harness context survives the projection (KRTX-2597): a synthetic
          // prompt part stays synthetic, so the turn model reads the prompt
          // as an internal continuation and the transcript never renders it
          // as a user bubble.
          m.blocks.push({ type: 'text', id: (part?.id as string | undefined) ?? `${id}-n${i}`, text: display, ...(modelText !== display ? { model_text: modelText } : {}), ...(part?.synthetic === true ? { synthetic: true } : {}) })
        } else if (c.type === 'image') {
          const part = pool.take('file', (p) => String(p.mime).startsWith('image/'))
          const block: J = { type: 'attachment', id: (part?.id as string | undefined) ?? `${id}-n${i}`, ...attachment(c, input.images), ...(part?.filename ? { name: part.filename } : {}) }
          if (!part) fromTags.push(block)
          m.blocks.push(block as SessionLogBlock)
        }
      })
      // An image with no v1 file part came from a `<file>` tag (images.ts), in tag order. Its
      // `source_path` lets a view show it once. A tag image pi left out breaks the count: none is set.
      const tags = msg.role === 'user' ? imageTagPaths(content.filter((c) => c.type === 'text').map((c) => String(c.text)).join('\n')) : []
      if (fromTags.length && fromTags.length === tags.length) fromTags.forEach((block, k) => (block.source_path = tags[k]!.path))
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
      if (m.role === 'user' && isRestoreNote(m)) m.origin = 'notification'
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
        const block = toolCall(c, part, results.get(c.id), edits, `${id}-n${i}`, input.images)
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
  return u
    ? { input: u.input ?? 0, output: u.output ?? 0, cache_read: u.cacheRead ?? 0, cache_write: u.cacheWrite ?? 0, ...(typeof u.reasoning === 'number' ? { reasoning: u.reasoning } : {}), ...(u.cost?.total ? { cost: u.cost.total } : {}) }
    : null
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

function toolCall(c: J, part: J | undefined, result: J | undefined, edits: Map<string, J[]>, fallbackId: string, images: Map<string, string>): ToolCallBlock {
  const time = part?.state?.time as { start?: number; end?: number } | undefined
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: (part?.id as string | undefined) ?? fallbackId,
    call_id: c.id,
    name: c.name,
    kind: toolKind(c.name),
    input: c.arguments,
    status: 'pending',
    ...(typeof part?.state?.title === 'string' && part.state.title ? { title: part.state.title } : {}),
    ...(time?.start ? { started_at: iso(time.start) } : {}),
  }
  if (c.thoughtSignature) block.ext = { pi: { version: PI_VERSION, data: { thoughtSignature: c.thoughtSignature } } }
  if (!result) return block
  const r = result.message as J
  const content = resultContent(r.content, images)
  block.status = r.isError ? 'error' : 'complete'
  block.ended_at = time?.end ? iso(time.end) : iso(r.timestamp)
  block.result = { content, is_error: r.isError === true, ...(r.isError ? { error: { message: textOf(content) } } : {}) }
  const edit = edits.get(result.id)?.at(-1)
  if (edit) {
    // What pi sends for a pruned result: its replacement, or pi-ai's "No result provided" for none.
    block.result.model_content = edit.replacement === null ? [{ type: 'text', text: PI_NO_RESULT }] : resultContent(edit.replacement.content, images)
    block.result.cleared_at = isoOf(edit.timestamp)
  }
  if (r.nestedCalls) block.result.details = codemodeDetails(r.nestedCalls)
  if (r.details !== undefined) block.ext = { pi: { version: PI_VERSION, native_id: result.id, data: { ...((block.ext?.pi?.data as J) ?? {}), details: r.details } } }
  return block
}

/** C2/F11: at rest, a call with no result is closed with the text pi-ai sends for it. */
function close(block: ToolCallBlock): void {
  block.status = 'error'
  block.result = { content: [{ type: 'text', text: PI_NO_RESULT }], is_error: true, synthetic: true, error: { code: 'interrupted', message: PI_NO_RESULT } }
}

/** The whole session as a log, each message's native hash, and each image's base64 data by sha256. */
export function piSessionLog(s: PiSessionSnapshot): { log: SessionLog; hashes: Map<string, string>; images: Map<string, string> } {
  const created = s.header?.timestamp ?? iso(0)
  const hashes = new Map<string, string>()
  const images = new Map<string, string>()
  const finish = (derived: Derived[]) =>
    derived.map(({ message, native }) => {
      hashes.set(message.message_id, sha256(JSON.stringify([message.seq, native])))
      return message
    })
  const all = s.entries as J[]
  const seqOf = rootSeqs(s)
  const branch = activeBranch(all, s.leafId)
  const store = codemodeStore(branch)
  const rootMessages = finish(deriveThread({ threadId: s.rootId, entries: branch, ids: (e) => s.entryMessageIds[e.id], transcript: s.transcript, busy: s.busy, child: false, seqOf: (e) => seqOf(e.id), createdAt: Date.parse(created), images }))
  const root: SessionLogThread = {
    ...V, thread_id: s.rootId, parent_thread_id: null, spawned_by: null, agent: s.agent, title: s.title, created_at: created, messages: rootMessages,
    ...(s.header ? { ext: { pi: { version: PI_VERSION, native_id: s.header.id, data: { cwd: s.header.cwd, header_version: s.header.version ?? null, ...(Object.keys(store).length ? { codemode_store: store } : {}) } } } } : {}),
  }
  const children = s.children.map((child): SessionLogThread => {
    const entries = child.agentMessages.map((m, i) => ({ type: 'message', id: `${child.id}:s${child.seqs[i]}`, index: i, message: m }))
    const messages = finish(deriveThread({ threadId: child.id, entries, ids: (e) => child.messageIds[e.index] ?? undefined, transcript: child.transcript, busy: child.busy, child: true, seqOf: (e) => child.seqs[e.index]!, createdAt: child.createdAt, images }))
    return { ...V, thread_id: child.id, parent_thread_id: s.rootId, spawned_by: spawnedBy(rootMessages, child.id), agent: child.agentName, title: child.title, created_at: iso(child.createdAt), messages }
  })
  const log: SessionLog = {
    ...V, session_id: s.sessionId, title: s.title, created_at: created, restore_grade: 'native',
    harness: { current: 'pi', history: [{ harness: 'pi', version: PI_VERSION, from_seq: 1, at: created }] },
    selection: { agent: s.agent, model: s.model },
    todos: [], pending: { questions: [], permissions: [] },
    threads: [root, ...children],
  }
  return { log, hashes, images }
}

/** The seq of a root entry by id, and of the next entry (`undefined`): see the seq rule. */
function rootSeqs(s: PiSessionSnapshot): (entryId?: string) => number {
  const restored = s.entrySeqs ?? {}
  const position = new Map(s.entries.map((e, i) => [e.id, i + 1]))
  let base = 0
  for (const [id, seq] of Object.entries(restored)) base = Math.max(base, seq - (position.get(id) ?? seq))
  return (entryId) => (entryId === undefined ? s.entries.length + 1 + base : restored[entryId] ?? position.get(entryId)! + base)
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

/** A live message's seq (see the header) and pi timestamp; null for a message pi has not appended that is not the reply it streams. */
export function piLive(s: PiSessionSnapshot, threadId: string, messageId: string): { seq: number; created_at: string } | null {
  // As deriveThread times each record.
  const at = (m: J | undefined) => iso(m?.timestamp)
  if (threadId === s.rootId) {
    const seqOf = rootSeqs(s)
    const e = s.entries.find((x) => s.entryMessageIds[x.id] === messageId) as J | undefined
    if (e) return { seq: seqOf(e.id), created_at: e.type === 'compaction' ? isoOf(e.timestamp) : at(e.type === 'message' ? e.message : e) }
    return messageId === s.reply?.id ? { seq: seqOf(), created_at: at(s.reply) } : null
  }
  const child = s.children.find((c) => c.id === threadId)
  if (!child) return null
  const i = child.messageIds.indexOf(messageId)
  if (i >= 0) return { seq: child.seqs[i]!, created_at: at(child.agentMessages[i]) }
  return messageId === child.reply?.id ? { seq: child.nextSeq, created_at: at(child.reply) } : null
}

/** The session-log port over a live pi runtime. `read` returns null while the runtime is down; `target` is where `restore` writes. */
export function createPiSessionLogPort(read: () => PiSessionSnapshot | null, target?: PiRestoreTarget): SessionLogPort {
  let lastSession: string | null = null
  /** The last export's images: the strings of the snapshot it read, replaced at each export. */
  let images = new Map<string, string>()
  return {
    capabilities: PI_CAPABILITIES,
    async changes(cursors: readonly ExportCursor[]): Promise<SessionLogChanges> {
      const s = read()
      if (!s) return { messages: [], tombstones: [], threads: [] }
      const exported = piSessionLog(s)
      const { log, hashes } = exported
      images = exported.images
      const out = logChanges(log, hashes, cursors, lastSession)
      lastSession = out.sessionJson
      return out.changes
    },
    /** Writes `log` into the dump the runtime loads at its next start (`session-log-restore.ts`); needs `target`. */
    async restore(log: SessionLog, seqMax?: Readonly<Record<string, number>>, readAttachment?: BytesReader): Promise<SessionLogRestoreResult> {
      if (!target) throw new Error('pi session-log restore needs a target (state dir, session id, workspace)')
      return restorePiSessionLog(log, readAttachment ? { ...target, readAttachment } : target, seqMax)
    },
    /** Every message id of the store; null without a dump. pi deletes no message (entries are append-only). */
    async held() {
      const s = read()
      return s ? new Set(piSessionLog(s).log.threads.flatMap((t) => t.messages.map((m) => m.message_id))) : null
    },
    live(threadId: string, messageId: string) {
      const s = read()
      return s ? piLive(s, threadId, messageId) : null
    },
    blob(sha256: string) {
      const data = images.get(sha256)
      return data === undefined ? null : Buffer.from(data, 'base64')
    },
  }
}
