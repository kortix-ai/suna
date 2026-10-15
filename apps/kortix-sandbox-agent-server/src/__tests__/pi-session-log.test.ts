/**
 * The pi session-log adapter (P2.5) on a synthetic pi native store.
 *
 * The fixture is what `PiRuntime.sessionLogSnapshot()` returns: pi
 * `SessionManager` entries (the shapes pi 1.0.3 writes), a sub-agent child's
 * `AgentMessage[]`, the Kortix v1 transcript and the id maps. It covers text,
 * reasoning, a tool call with its result, an interrupted call, an aborted
 * reply, a failed attempt pi omitted, a compaction, a user image and a file pi
 * never received, and a `task` child. The journal test feeds this adapter to
 * the real journal against a `Bun.serve` fake API.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AdapterCapabilitiesSchema,
  SessionLogJournalRequestSchema,
  upcast,
  type ExportCursor,
  type SessionLogJournalRequest,
  type SessionLogMessage,
} from '@kortix/api-contract/session-log'
import { createPiSessionLogPort, piSessionLog, PI_CAPABILITIES, PI_VERSION, type PiSessionSnapshot } from '@/harness/pi/session-log'
import { readPiSnapshot, restorePiSessionLog } from '@/harness/pi/session-log-restore'
import { mintRootId } from '@/harness/pi/message-id'
import { SessionLogJournal, resetSessionLogJournalForTests, startSessionLogJournal } from '@/harness/shared/session-log-journal'
import { TranscriptStore } from '@/harness/pi/transcript'
import { PiTurnEvents } from '@/harness/pi/turn-events'
import { kortixEventBus, resetKortixEventBusForTests, sessionLogEventBus } from '@/services/event-bus/kortix-event-bus'
import { resetSessionTokenHealthForTests } from '@/lib/kortix-api/session-token-health'

const ROOT = 'ses_piroot000000000000000001'
const CHILD = 'ses_pichild00000000000000001'
const PNG = Buffer.from('synthetic-png-bytes').toString('base64')
const PDF = `data:application/pdf;base64,${Buffer.from('synthetic-pdf').toString('base64')}`
const ts = (n: number) => 1_760_000_000_000 + n * 1000
const at = (n: number) => new Date(ts(n)).toISOString()
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 19, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

let n = 0
let leaf: string | null = null
/** A pi entry appended at the leaf, as `SessionManager` appends it. */
const entry = (fields: Record<string, unknown>) => {
  const e = { id: `e${String(++n).padStart(7, '0')}`, parentId: leaf, timestamp: at(n), ...fields }
  leaf = e.id
  return e
}
const user = (content: unknown) => entry({ type: 'message', message: { role: 'user', content, timestamp: ts(n + 1) } })
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  entry({ type: 'message', message: { role: 'assistant', content, api: 'openai-completions', provider: 'kortix', model: 'answer-model', usage, stopReason: 'stop', timestamp: ts(n + 1), ...extra } })
const toolResult = (toolCallId: string, toolName: string, text: string, extra: Record<string, unknown> = {}) =>
  entry({ type: 'message', message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false, timestamp: ts(n + 1), ...extra } })

/** A v1 transcript message with its parts, as the runtime publishes it. */
const v1 = (id: string, role: 'user' | 'assistant', parts: Array<Record<string, unknown>>, info: Record<string, unknown> = {}) => ({
  info: { id, role, sessionID: ROOT, time: { created: 0, completed: 1 }, ...(role === 'user' ? { agent: 'build', model: { providerID: 'kortix', modelID: 'selected-model' } } : { modelID: 'selected-model', providerID: 'kortix', agent: 'build' }), ...info },
  parts: parts.map((p, i) => ({ id: `${id}-p${i}`, messageID: id, sessionID: ROOT, ...p })),
})

function fixture(): PiSessionSnapshot {
  n = 0
  leaf = null
  const e = {
    prompt: user([{ type: 'text', text: 'Describe the image.' }, { type: 'image', data: PNG, mimeType: 'image/png' }]),
    reply: assistant([
      { type: 'thinking', thinking: 'I should list files.', thinkingSignature: 'sig-1' },
      { type: 'text', text: 'Listing.' },
      { type: 'toolCall', id: 'call_ls', name: 'bash', arguments: { command: 'ls' } },
    ], { stopReason: 'toolUse' }),
    lsResult: toolResult('call_ls', 'bash', 'a.txt'),
    done: assistant([{ type: 'text', text: 'One file.' }]),
    sleepPrompt: user('Run sleep.'),
    sleep: assistant([{ type: 'toolCall', id: 'call_sleep', name: 'bash', arguments: { command: 'sleep 60' } }], { stopReason: 'toolUse' }),
    again: user('Again.'),
    aborted: assistant([{ type: 'text', text: 'Partial' }], { stopReason: 'aborted', errorMessage: 'Request was aborted' }),
    failed: assistant([{ type: 'text', text: '' }], { stopReason: 'error', errorMessage: '503 upstream unavailable' }),
  }
  const omit = entry({ type: 'context_edit', targetId: e.failed.id, replacement: null })
  const compaction = entry({ type: 'compaction', summary: 'SUMMARY: one file listed.', firstKeptEntryId: e.again.id, tokensBefore: 1234 })
  const spawn = user('Spawn a helper.')
  const task = assistant([{ type: 'toolCall', id: 'call_task', name: 'task', arguments: { description: 'Write the note', prompt: 'write sub.txt', subagent_type: 'general' } }], { stopReason: 'toolUse' })
  const taskResult = toolResult('call_task', 'task', `task_id: ${CHILD}\n\n<task_result>\nwrote sub.txt\n</task_result>`, { details: { sessionId: CHILD } })
  const parentDone = assistant([{ type: 'text', text: 'Parent done.' }], { model: 'second-model' })
  const entries = [e.prompt, e.reply, e.lsResult, e.done, e.sleepPrompt, e.sleep, e.again, e.aborted, e.failed, omit, compaction, spawn, task, taskResult, parentDone]
  const ids: Record<string, string> = {
    [e.prompt.id]: 'msg_a', [e.reply.id]: 'msg_b', [e.done.id]: 'msg_c', [e.sleepPrompt.id]: 'msg_d', [e.sleep.id]: 'msg_e',
    [e.again.id]: 'msg_f', [e.aborted.id]: 'msg_g', [e.failed.id]: 'msg_h', [compaction.id]: 'msg_i', [spawn.id]: 'msg_j', [task.id]: 'msg_k', [parentDone.id]: 'msg_l',
  }
  const childMessages = [
    { role: 'user', content: 'write sub.txt', timestamp: ts(50) },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call_child', name: 'write', arguments: { path: 'sub.txt', content: 'x' } }], api: 'openai-completions', provider: 'kortix', model: 'answer-model', usage, stopReason: 'toolUse', timestamp: ts(51) },
    { role: 'toolResult', toolCallId: 'call_child', toolName: 'write', content: [{ type: 'text', text: 'Wrote sub.txt' }], isError: false, timestamp: ts(52) },
    { role: 'assistant', content: [{ type: 'text', text: 'wrote sub.txt' }], api: 'openai-completions', provider: 'kortix', model: 'answer-model', usage, stopReason: 'stop', timestamp: ts(53) },
  ]
  return {
    sessionId: 'session-pi-log',
    rootId: ROOT,
    title: 'Describe the image.',
    header: { type: 'session', version: 3, id: 'hdr-0001', timestamp: at(0), cwd: '/workspace' },
    entries: entries as never,
    leafId: leaf,
    entryMessageIds: ids,
    transcript: [
      v1('msg_a', 'user', [{ type: 'text', text: 'Describe the image.' }, { type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG}`, filename: 'shot.png' }, { type: 'file', mime: 'application/pdf', url: PDF, filename: 'notes.pdf' }]),
      v1('msg_b', 'assistant', [{ type: 'reasoning', text: 'I should list files.' }, { type: 'text', text: 'Listing.' }, { type: 'tool', tool: 'bash', callID: 'msg_b-p2', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', title: 'bash', time: { start: ts(3), end: ts(4) } } }], { parentID: 'msg_a' }),
      v1('msg_c', 'assistant', [{ type: 'text', text: 'One file.' }]),
      v1('msg_d', 'user', [{ type: 'text', text: 'Run sleep.' }]),
      v1('msg_e', 'assistant', [{ type: 'tool', tool: 'bash', callID: 'msg_e-p0', state: { status: 'running', input: { command: 'sleep 60' }, time: { start: ts(9) } } }]),
      v1('msg_i', 'user', [{ type: 'compaction', auto: true }]),
      v1('msg_k', 'assistant', [{ type: 'tool', tool: 'task', callID: 'msg_k-p0', state: { status: 'completed', input: {}, output: '', time: { start: 1, end: 2 } } }]),
    ] as never,
    children: [{
      id: CHILD, title: 'Write the note', agentName: 'general', createdAt: ts(50), agentMessages: childMessages as never, messageIds: ['msg_c1', 'msg_c2', null, 'msg_c3'], seqs: [1, 2, 3, 4], nextSeq: 5, reply: null,
      transcript: [v1('msg_c2', 'assistant', [{ type: 'tool', tool: 'write', callID: 'msg_c2-p0', state: { status: 'completed', input: {}, output: 'Wrote sub.txt', time: { start: 1, end: 2 } } }])] as never,
      busy: false,
    }],
    busy: false,
    reply: null,
    agent: 'build',
    model: { provider: 'kortix', model: 'answer-model' },
  }
}

const root = (s: PiSessionSnapshot) => piSessionLog(s).log.threads[0]!.messages
const byId = (messages: SessionLogMessage[], id: string) => messages.find((m) => m.message_id === id)!

describe('pi session-log export', () => {
  test('every exported record validates with upcast(), and the capabilities validate', () => {
    const { log } = piSessionLog(fixture())
    expect(() => upcast(log)).not.toThrow()
    expect(log.threads.map((t) => [t.thread_id, t.messages.length])).toEqual([[ROOT, 12], [CHILD, 3]])
    expect(log).toMatchObject({ restore_grade: 'native', harness: { current: 'pi' }, session_id: 'session-pi-log' })
    expect(AdapterCapabilitiesSchema.parse(PI_CAPABILITIES)).toBeTruthy()
    for (const m of log.threads.flatMap((t) => t.messages)) expect(m.producer).toEqual({ harness: 'pi', harness_version: PI_VERSION, adapter_version: '1.1.0' })
  })

  test('block ids are the pi part ids; a block with no part gets a position id', () => {
    const messages = root(fixture())
    expect(byId(messages, 'msg_a').blocks.map((b) => b.id)).toEqual(['msg_a-p0', 'msg_a-p1', 'msg_a-p2'])
    expect(byId(messages, 'msg_b').blocks.map((b) => [b.type, b.id])).toEqual([['reasoning', 'msg_b-p0'], ['text', 'msg_b-p1'], ['tool_call', 'msg_b-p2']])
    // No v1 row for the aborted reply: position-derived.
    expect(byId(messages, 'msg_g').blocks.map((b) => b.id)).toEqual(['msg_g-n0'])
  })

  test('the model comes from the pi message, not the model the v1 row recorded', () => {
    const messages = root(fixture())
    expect(byId(messages, 'msg_b').model).toEqual({ provider: 'kortix', model: 'answer-model', api: 'openai-chat' })
    expect(byId(messages, 'msg_l').model?.model).toBe('second-model')
    // A user message keeps the model selected when it was sent.
    expect(byId(messages, 'msg_a').model).toEqual({ provider: 'kortix', model: 'selected-model' })
  })

  test('an interrupted call is closed at rest; while the turn runs it is open and streaming', () => {
    const atRest = byId(root(fixture()), 'msg_e').blocks[0]
    expect(atRest).toMatchObject({
      type: 'tool_call', id: 'msg_e-p0', call_id: 'call_sleep', status: 'error',
      result: { content: [{ type: 'text', text: 'No result provided' }], is_error: true, synthetic: true, error: { code: 'interrupted', message: 'No result provided' } },
    })
    const s = fixture()
    s.entries = s.entries.slice(0, 6) as never // the turn is still in the sleep call
    s.leafId = (s.entries.at(-1) as unknown as { id: string }).id
    s.busy = true
    const live = byId(root(s), 'msg_e')
    expect(live.status).toBe('streaming')
    expect(live.blocks[0]).toMatchObject({ status: 'running' })
    expect((live.blocks[0] as { result?: unknown }).result).toBeUndefined()
  })

  test('tool results, reasoning, the aborted reply and the omitted failed attempt', () => {
    const messages = root(fixture())
    const b = byId(messages, 'msg_b')
    expect(b.blocks[0]).toMatchObject({ type: 'reasoning', text: 'I should list files.', ext: { pi: { data: { thinkingSignature: 'sig-1' } } } })
    expect(b.blocks[2]).toMatchObject({ status: 'complete', kind: 'shell', result: { content: [{ type: 'text', text: 'a.txt' }], is_error: false }, started_at: new Date(ts(3)).toISOString() })
    expect(b).toMatchObject({ finish: 'tool_calls', reply_to: 'msg_a', in_context: true })
    expect(byId(messages, 'msg_g')).toMatchObject({ status: 'aborted', in_context: false, hidden_reason: 'aborted', error: { code: 'aborted' } })
    expect(byId(messages, 'msg_h')).toMatchObject({ status: 'error', in_context: false, hidden_reason: 'failed_attempt' })
  })

  test('P2.10: usage carries pi\'s reasoning tokens; a call keeps the v1 title', () => {
    const b = byId(root(fixture()), 'msg_b')
    expect(b.usage).toEqual({ input: 10, output: 5, cache_read: 0, cache_write: 0, reasoning: 19 })
    expect(b.blocks[2]).toMatchObject({ type: 'tool_call', name: 'bash', title: 'bash' })
    // A v1 call with no title (the task call) has none in the log.
    expect(byId(root(fixture()), 'msg_k').blocks[0]).not.toHaveProperty('title')
  })

  test('P2.10: a child\'s context message pi-ai stamps 0 is timed at the child\'s creation', () => {
    const s = fixture()
    const child = s.children[0]!
    child.agentMessages = [{ role: 'system', content: 'You are a helper.', timestamp: 0 }, ...child.agentMessages] as never
    child.messageIds = [null, ...child.messageIds]
    child.seqs = [5, ...child.seqs]
    const context = piSessionLog(s).log.threads[1]!.messages.find((m) => m.kind === 'context')!
    expect(context).toMatchObject({ role: 'system', created_at: at(50), completed_at: at(50) })
  })

  test('a compaction keeps pi shape: summary, first kept message, trigger', () => {
    const c = byId(root(fixture()), 'msg_i')
    expect(c).toMatchObject({ role: 'user', kind: 'compaction', in_context: true })
    expect(c.blocks).toEqual([{ type: 'compaction', id: 'msg_i-p0', summary: 'SUMMARY: one file listed.', first_kept_message_id: 'msg_f', tokens_before: 1234, trigger: 'auto' }])
  })

  test('a user image is an attachment with ref and bytes; a file pi never received is a model-invisible block', () => {
    const [text, image, pdf] = byId(root(fixture()), 'msg_a').blocks
    const bytes = Buffer.from(PNG, 'base64')
    const digest = createHash('sha256').update(bytes).digest('hex')
    expect(text).toEqual({ type: 'text', id: 'msg_a-p0', text: 'Describe the image.' })
    expect(image).toEqual({ type: 'attachment', id: 'msg_a-p1', ref: `blob:${digest}`, bytes: bytes.length, sha256: digest, mime: 'image/png', name: 'shot.png' })
    expect(pdf).toMatchObject({ type: 'harness', id: 'msg_a-p2', kind: 'undelivered_file', model_visible: false, data: { mime: 'application/pdf', filename: 'notes.pdf' } })
    expect(JSON.stringify(pdf)).not.toContain('base64')
  })

  test('a sub-agent child is a thread spawned by the task call', () => {
    const child = piSessionLog(fixture()).log.threads[1]!
    expect(child).toMatchObject({ thread_id: CHILD, parent_thread_id: ROOT, spawned_by: { message_id: 'msg_k', call_id: 'call_task' }, agent: 'general' })
    expect(child.messages.map((m) => [m.message_id, m.role, m.seq])).toEqual([['msg_c1', 'user', 1], ['msg_c2', 'assistant', 2], ['msg_c3', 'assistant', 4]])
    expect(child.messages[0]!.origin).toBe('subagent')
    expect(child.messages[1]!.blocks[0]).toMatchObject({ id: 'msg_c2-p0', call_id: 'call_child', status: 'complete' })
  })

  test('native_hash is stable with no change and moves when the message changes', () => {
    const first = piSessionLog(fixture()).hashes
    expect(piSessionLog(fixture()).hashes).toEqual(first)
    const s = fixture()
    ;((s.entries[2] as unknown as { message: { content: Array<{ text: string }> } }).message.content[0]!).text = 'a.txt\nb.txt'
    const changed = piSessionLog(s).hashes
    expect([...changed].filter(([id, hash]) => first.get(id) !== hash).map(([id]) => id)).toEqual(['msg_b'])
  })

  test('changes(cursors) returns only messages after last_seq plus changed earlier ones, and tombstones', async () => {
    let s = fixture()
    const port = createPiSessionLogPort(() => s)
    const first = await port.changes([])
    expect(first.messages).toHaveLength(15)
    expect(first.session).toMatchObject({ session_id: 'session-pi-log' })
    const cursors: ExportCursor[] = first.threads.map((t) => {
      const mine = first.messages.filter((m) => m.message.thread_id === t.thread_id)
      return { thread_id: t.thread_id, last_seq: Math.max(...mine.map((m) => m.message.seq)), native_hashes: Object.fromEntries(mine.map((m) => [m.message.message_id, m.native_hash])) }
    })
    const idle = await port.changes(cursors)
    expect(idle.messages).toEqual([])
    expect(idle.session).toBeUndefined()

    s = fixture()
    s.entries = [...s.entries, { type: 'message', id: 'e9999999', parentId: s.leafId, timestamp: at(99), message: { role: 'user', content: 'Next.', timestamp: ts(99) } }] as never
    s.leafId = 'e9999999'
    ;((s.entries[2] as unknown as { message: { content: Array<{ text: string }> } }).message.content[0]!).text = 'edited'
    s.children[0]!.agentMessages = s.children[0]!.agentMessages.slice(0, 3)
    s.children[0]!.messageIds = s.children[0]!.messageIds.slice(0, 3)
    s.children[0]!.seqs = s.children[0]!.seqs.slice(0, 3)
    const next = await port.changes(cursors)
    expect(next.messages.map((m) => m.message.message_id)).toEqual(['msg_b', 'pi:e9999999'])
    expect(next.tombstones).toEqual(['msg_c3'])
  })
})

describe('the seq rule: monotonic per thread, never reused', () => {
  test('root seqs follow pi entry order: a message after a rewind gets a higher seq than the messages it left', () => {
    const s = fixture()
    const before = root(s)
    expect(before.map((m) => m.seq)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15])
    // Rewind to the first reply, then a new prompt on that branch.
    const reply = (s.entries[1] as unknown as { id: string }).id
    s.entries = [...s.entries, { type: 'message', id: 'e8888888', parentId: reply, timestamp: at(98), message: { role: 'user', content: 'Instead.', timestamp: ts(98) } }] as never
    s.entryMessageIds.e8888888 = 'msg_rewound'
    s.leafId = 'e8888888'
    const after = root(s)
    expect(after.map((m) => m.message_id)).toEqual(['msg_a', 'msg_b', 'msg_rewound'])
    expect(after.slice(0, 2).map((m) => m.seq)).toEqual([1, 2])
    expect(after[2]!.seq).toBeGreaterThan(Math.max(...before.map((m) => m.seq)))
  })

  test('a child message that replaces a dropped one gets a new seq above it', async () => {
    let s = fixture()
    const port = createPiSessionLogPort(() => s)
    const first = await port.changes([])
    const cursor = (thread: string): ExportCursor => {
      const mine = first.messages.filter((m) => m.message.thread_id === thread)
      return { thread_id: thread, last_seq: Math.max(...mine.map((m) => m.message.seq)), native_hashes: Object.fromEntries(mine.map((m) => [m.message.message_id, m.native_hash])) }
    }
    // pi's retry drops the child's last (failed) reply and appends a new one at the same index.
    s = fixture()
    const child = s.children[0]!
    child.agentMessages = [...child.agentMessages.slice(0, 3), { ...(child.agentMessages[3] as object), content: [{ type: 'text', text: 'second try' }] }] as never
    child.messageIds = [...child.messageIds.slice(0, 3), 'msg_c4']
    child.seqs = [1, 2, 3, 5]
    const next = await port.changes([cursor(ROOT), cursor(CHILD)])
    expect(next.tombstones).toEqual(['msg_c3'])
    expect(next.messages.map((m) => [m.message.message_id, m.message.seq])).toEqual([['msg_c4', 5]])
  })

  test('live (P4.3b): a stored message has its record seq; the reply pi streams gets the next entry; a child reply gets nextSeq', async () => {
    const s = fixture()
    const port = createPiSessionLogPort(() => s)
    const records = new Map(piSessionLog(s).log.threads.flatMap((t) => t.messages).map((m) => [m.message_id, m]))
    for (const id of ['msg_a', 'msg_e']) expect(port.live(ROOT, id)).toEqual({ seq: records.get(id)!.seq, created_at: records.get(id)!.created_at })
    expect(port.live(CHILD, 'msg_c3')).toEqual({ seq: 4, created_at: records.get('msg_c3')!.created_at })
    // Not stored and not streaming: a prompt pi has not appended yet.
    expect(port.live(ROOT, 'msg_new')).toBeNull()
    s.reply = { id: 'msg_new', timestamp: ts(60) }
    expect(port.live(ROOT, 'msg_new')).toEqual({ seq: s.entries.length + 1, created_at: new Date(ts(60)).toISOString() })
    s.children[0]!.reply = { id: 'msg_c5', timestamp: ts(61) }
    expect(port.live(CHILD, 'msg_c5')).toEqual({ seq: 5, created_at: new Date(ts(61)).toISOString() })
    expect(port.live('ses_unknown', 'msg_new')).toBeNull()
  })
})

describe('pi session-log restore (P6.2)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const image = Buffer.from(PNG, 'base64')
  const imageRef = `blob:${createHash('sha256').update(image).digest('hex')}`
  /** The fixture as a box of session `session-pi-log` exports it: pi's root id is minted from the session id. */
  const exported = () => {
    const s = fixture()
    s.rootId = mintRootId(s.sessionId)
    return piSessionLog(s)
  }
  const restore = async (log: ReturnType<typeof exported>['log'], readAttachment = async (ref: string) => (ref === imageRef ? image : null)) => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-restore-'))
    dirs.push(dir)
    const result = await restorePiSessionLog(log, { stateDir: dir, sessionId: 'session-pi-log', cwd: '/workspace', readAttachment })
    return { result, again: piSessionLog(readPiSnapshot(dir, 'session-pi-log', log.selection)!) }
  }

  test('round trip: export, restore into a fresh state dir, export again: the same records', async () => {
    const { log } = exported()
    const { result, again } = await restore(log)
    const expected = structuredClone(log)
    // The one difference: pi never received the PDF, so the log has its size, not its bytes; the restored v1 part has no url.
    const pdf = expected.threads[0]!.messages[0]!.blocks[2] as { data: Record<string, unknown> }
    pdf.data = { mime: 'application/pdf', filename: 'notes.pdf', url: '' }
    expect(again.log).toEqual(expected)
    expect(result.dropped).toEqual({})
  })

  test('the cursors restore returns hold the hash of every restored message: the next export sends nothing (C13)', async () => {
    const { log } = exported()
    const { result, again } = await restore(log)
    expect(result.cursors.map((c) => c.thread_id)).toEqual(log.threads.map((t) => t.thread_id))
    for (const c of result.cursors) {
      const thread = again.log.threads.find((t) => t.thread_id === c.thread_id)!
      expect(c.native_hashes).toEqual(Object.fromEntries(thread.messages.map((m) => [m.message_id, again.hashes.get(m.message_id)!])))
      expect(c.last_seq).toBe(Math.max(...thread.messages.map((m) => m.seq)))
    }
  })

  test('an image whose bytes cannot be read is dropped, and counted when the model would see it', async () => {
    const { log } = exported()
    // msg_a is before the compaction's cut point: the model does not see it, so nothing it sees is lost.
    expect((await restore(log, async () => null)).result.dropped).toEqual({})
    byId(log.threads[0]!.messages, 'msg_i').in_context = false
    const { result, again } = await restore(log, async () => null)
    expect(result.dropped).toEqual({ attachment: 1 })
    // The store says what pi holds: the image is a file pi never received.
    expect(again.log.threads[0]!.messages[0]!.blocks.map((b) => (b.type === 'harness' ? `${b.kind}:${(b.data as { mime: string }).mime}` : b.type))).toEqual(['text', 'undelivered_file:image/png', 'undelivered_file:application/pdf'])
  })
})

describe('pi session-log adapter through the journal', () => {
  const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL', 'KORTIX_SESSION_LOG_DUMP_DIR'] as const
  let saved: Record<string, string | undefined> = {}
  const servers: Array<{ stop(force?: boolean): void }> = []
  beforeEach(() => {
    resetSessionLogJournalForTests()
    resetSessionTokenHealthForTests()
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    process.env.KORTIX_PROJECT_ID = 'project-1'
    process.env.KORTIX_SESSION_ID = 'session-pi-log'
    process.env.KORTIX_TOKEN = 'session-token'
    delete process.env.KORTIX_SESSION_LOG_DUMP_DIR
  })
  afterEach(() => {
    resetSessionLogJournalForTests()
    resetSessionTokenHealthForTests()
    for (const server of servers.splice(0)) server.stop(true)
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  test('the journal posts batches whose bodies validate, then nothing while pi is unchanged', async () => {
    const bodies: SessionLogJournalRequest[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await request.arrayBuffer())))) as SessionLogJournalRequest
        bodies.push(body)
        return Response.json({ acked: [...body.puts.map((p) => ({ message_id: p.message.message_id, rev: p.rev })), ...body.tombstones] })
      },
    })
    servers.push(server)
    process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`
    const journal = startSessionLogJournal(createPiSessionLogPort(fixture), { generation: 0 })!
    expect(await journal.flush()).toBe(true)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(SessionLogJournalRequestSchema.safeParse(body).success).toBe(true)
    expect(bodies.flatMap((b) => b.puts)).toHaveLength(15)
    expect(bodies[0]!.threads.map((t) => t.thread_id)).toEqual([ROOT, CHILD])
    expect(bodies[0]!.session).toMatchObject({ restore_grade: 'native' })
    const posts = bodies.length
    expect(await journal.flush()).toBe(true)
    expect(bodies.length).toBe(posts)
  })

  test('KORTIX_SESSION_LOG_DUMP_DIR writes each batch as JSON and posts nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-session-log-dump-'))
    process.env.KORTIX_SESSION_LOG_DUMP_DIR = dir
    process.env.KORTIX_API_URL = 'http://127.0.0.1:9' // nothing listens: a post would fail the flush
    try {
      const journal = startSessionLogJournal(createPiSessionLogPort(fixture), { generation: 0 })!
      expect(await journal.flush()).toBe(true)
      const files = readdirSync(dir)
      expect(files.length).toBe(1)
      const body = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'))
      expect(SessionLogJournalRequestSchema.parse(body).puts).toHaveLength(15)
      expect(await journal.flush()).toBe(true)
      expect(readdirSync(dir).length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('live turn (P4.8): the live puts, the deltas and the turn end\'s put name each block and each call alike', async () => {
    resetKortixEventBusForTests()
    n = 0
    leaf = null
    const prompt = user('List files.')
    const entries: Array<Record<string, unknown>> = [prompt]
    const entryMessageIds: Record<string, string> = { [prompt.id]: 'msg_u' }
    const store = new TranscriptStore()
    let busy = true
    const snapshot = (): PiSessionSnapshot => ({
      sessionId: 'session-pi-live', rootId: ROOT, title: 'List files.', header: null, entries: entries as never, leafId: leaf, entryMessageIds,
      transcript: store.all(), children: [], busy, reply: busy ? { id: 'msg_r', timestamp: ts(2) } : null, agent: 'build', model: { provider: 'kortix', model: 'answer-model' },
    })
    let clock = ts(2)
    const turn = new PiTurnEvents({
      sessionID: ROOT, mintMessageId: () => 'msg_r', parentMessageId: () => 'msg_u', model: () => ({ providerID: 'kortix', modelID: 'answer-model' }),
      agent: () => 'build', workspace: '/workspace', now: () => ++clock,
    })
    // As PiRuntime.publish: every frame into the transcript, all but the full-text twins onto the v1 bus.
    const emit = (event: unknown) => {
      for (const frame of turn.translate(event as never)) {
        store.apply(frame as never)
        if (!frame.transcriptOnly) kortixEventBus().publish(frame.type, frame.properties, ROOT)
      }
    }
    store.apply({ type: 'message.updated', properties: { sessionID: ROOT, info: { id: 'msg_u', sessionID: ROOT, role: 'user', time: { created: ts(1) } } } } as never)
    store.apply({ type: 'message.part.updated', properties: { sessionID: ROOT, part: { id: 'msg_u-p0', messageID: 'msg_u', sessionID: ROOT, type: 'text', text: 'List files.' } } } as never)
    const journal = new SessionLogJournal(createPiSessionLogPort(snapshot), { generation: 1 })
    await journal.collect()
    const frames: Array<{ type: string; payload: any }> = []
    sessionLogEventBus().subscribe((e) => void frames.push(e), {})

    const final = { role: 'assistant', api: 'openai-completions', provider: 'kortix', model: 'answer-model', usage, stopReason: 'toolUse', timestamp: ts(2), content: [
      { type: 'thinking', thinking: 'List them.' },
      { type: 'text', text: 'Listing.' },
      { type: 'toolCall', id: 'call-7201ad64fe82', name: 'bash', arguments: { command: 'ls' } },
    ] }
    const update = (assistantMessageEvent: Record<string, unknown>) => emit({ type: 'message_update', message: final, assistantMessageEvent })
    emit({ type: 'agent_start' })
    emit({ type: 'message_start', message: { ...final, content: [] } })
    update({ type: 'thinking_start', contentIndex: 0 })
    update({ type: 'thinking_delta', contentIndex: 0, delta: 'List them.' })
    update({ type: 'thinking_end', contentIndex: 0, content: 'List them.' })
    update({ type: 'text_start', contentIndex: 1 })
    update({ type: 'text_delta', contentIndex: 1, delta: 'Listing.' })
    update({ type: 'text_end', contentIndex: 1, content: 'Listing.' })
    emit({ type: 'message_end', message: final })
    entries.push(assistant(final.content, { stopReason: 'toolUse' }))
    entryMessageIds[leaf!] = 'msg_r'
    emit({ type: 'tool_execution_start', toolCallId: 'call-7201ad64fe82', toolName: 'bash', args: { command: 'ls' } })
    // A permission or question on this call names it as the block does.
    const ref = turn.toolRef('call-7201ad64fe82')
    emit({ type: 'tool_execution_end', toolCallId: 'call-7201ad64fe82', toolName: 'bash', result: { content: [{ type: 'text', text: 'a.txt' }] }, isError: false })
    entries.push(toolResult('call-7201ad64fe82', 'bash', 'a.txt'))
    busy = false
    emit({ type: 'agent_end', messages: [] })
    const livePuts = frames.filter((f) => f.type === 'log.message' && f.payload.message?.message_id === 'msg_r').map((f) => f.payload.message)
    const deltas = frames.filter((f) => f.type === 'log.block.delta').map((f) => f.payload.block_id)
    await journal.collect()
    const turnEnd = frames.filter((f) => f.type === 'log.message' && f.payload.message?.message_id === 'msg_r').at(-1)!.payload.message
    await journal.stop(0)

    expect(turnEnd.status).toBe('complete')
    const shape = (m: SessionLogMessage) => m.blocks.map((b) => (b.type === 'tool_call' ? [b.type, b.id, b.call_id] : [b.type, b.id]))
    expect(shape(turnEnd)).toEqual([['reasoning', 'msg_r-p0'], ['text', 'msg_r-p1'], ['tool_call', 'msg_r-p2', 'call-7201ad64fe82']])
    expect(livePuts.length).toBeGreaterThan(2)
    // Each live put names its blocks (and calls) as the turn end's put does.
    for (const put of livePuts) expect(shape(turnEnd).slice(0, put.blocks.length)).toEqual(shape(put))
    expect(shape(livePuts.at(-1)!)).toEqual(shape(turnEnd))
    expect(deltas).toEqual(['msg_r-p0', 'msg_r-p1'])
    expect(ref).toEqual({ messageID: 'msg_r', callID: 'call-7201ad64fe82' })
  })
})
