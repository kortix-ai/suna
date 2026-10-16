/**
 * The OpenCode session-log restore (P6.3) against the oracle: a log is restored
 * into a fresh OpenCode home (`opencode.db` through `opencode import`), the REAL
 * pinned OpenCode serves it against a local fake OpenAI-compatible model (dummy
 * key, isolated home, no other network), one prompt runs, and the request
 * OpenCode sent must equal `modelView(log)` plus that prompt
 * (`@kortix/api-contract/session-log` `threadView` + `compareViews`, the
 * OpenCode compare options). A sub-agent thread is resumed through `task` with
 * its `task_id`. Sources: the 7 golden fixtures of the 65/65 matrix, converted
 * and partial logs, an OpenCode session and a pi session recorded in this file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareOptionsFor,
  compareViews,
  fromV1,
  normalizeOpenAIChat,
  threadView,
  toV1,
  upcast,
  type SessionLog,
  type ViewTarget,
} from '@kortix/api-contract/session-log'
import type { SessionLogChanges, SessionLogPort } from '@/harness/contract/session-log'
import { loadConfig } from '@/harness/harness'
import { OpencodeDb } from '@/harness/open-code/opencode-db'
import { readOpenCodeSessionPin, writeOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import { reconcileSessionLog } from '@/harness/shared/session-log-boot'
import { flushSessionLogJournal, resetSessionLogJournalForTests, startSessionLogJournal } from '@/harness/shared/session-log-journal'
import { Database } from 'bun:sqlite'
import { fakeSessionLogApi } from './helpers/fake-session-log-api'
import { createOpenCodeSessionLogPort, OPENCODE_CAPABILITIES, openCodeSessionLog } from '@/harness/open-code/session-log'
import { restoreOpenCodeSessionLog, type OpenCodeRestoreTarget } from '@/harness/open-code/session-log-restore'
import { requirePiConfig } from '@/harness/pi/config'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { piSessionLog } from '@/harness/pi/session-log'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { startFakeModel, type ChatBody, type Step } from './helpers/fake-model'
import { OPENCODE_VERSION, openCodeBin, openCodeBox, PROVIDER, type OpenCodeServer } from './helpers/opencode-box'

const FIXTURES = join(import.meta.dir, '../../../../packages/api-contract/src/__tests__/fixtures/session-log')
const NAMES = ['golden', 'golden21', 'pi', 'opencode', 'opencode-v2', 'claude-code', 'codex'] as const
/** The fixtures' one image (`blob:<sha256>`): a synthetic 1x1 PNG. */
const FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const blobs = new Map([[`blob:${sha(FIXTURE_PNG)}`, FIXTURE_PNG]])
const MODEL_ID = 'test-model'
const TARGET: ViewTarget = { provider: PROVIDER, model: MODEL_ID, reasoning_replay: OPENCODE_CAPABILITIES.native.reasoning_replay }

let model: ReturnType<typeof startFakeModel>
let bin: string
const servers: OpenCodeServer[] = []
const services: PiHarnessService[] = []
const dirs: string[] = []
const saved: Record<string, string | undefined> = {}
beforeAll(async () => {
  model = startFakeModel(MODEL_ID)
  bin = await openCodeBin()
})
afterAll(() => model.stop())
beforeEach(() => {
  resetKortixEventBusForTests()
  for (const key of ['KORTIX_RUNTIME_STATE_DIR', 'HOME', 'KORTIX_MANAGED_SKILLS_DIR', 'KORTIX_PT_ENV_PATH']) saved[key] = process.env[key]
})
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const s of services.splice(0)) await s.lifecycle.stop().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetKortixEventBusForTests()
})

/** A fresh OpenCode box; its runtime state dir (pin, seq map) becomes the daemon's. */
function box(sessionId: string, readAttachment: (ref: string) => Promise<Buffer | null> = async (ref) => blobs.get(ref) ?? null) {
  const b = openCodeBox(bin, { origin: model.origin, id: MODEL_ID })
  dirs.push(b.root)
  const stateDir = join(b.root, 'state')
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
  const statePath = join(stateDir, 'opencode-session-log.json')
  const port: SessionLogPort = createOpenCodeSessionLogPort({
    db: new OpencodeDb(b.dbPath), dbPath: b.dbPath, sessionId, rootId: readOpenCodeSessionPin, statePath,
    restoreTarget: { bin, cwd: b.workspace, env: b.env, readAttachment },
  })
  const serve = async () => {
    const s = await b.serve()
    servers.push(s)
    return s
  }
  /** The OpenCode session id a log id was written under (a rejected id is re-keyed, see the restore header). */
  const native = (id: string) => {
    const ids = (JSON.parse(readFileSync(statePath, 'utf8')) as { ids?: Record<string, string> }).ids ?? {}
    return Object.entries(ids).find(([, logId]) => logId === id)?.[0] ?? id
  }
  return { ...b, port, serve, native, statePath }
}

async function post(server: OpenCodeServer, path: string, body: unknown) {
  const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : ((await res.json()) as any)
}

/** One prompt to an OpenCode session; returns the agent requests it sent (title requests have no tools). */
async function prompt(server: OpenCodeServer, sessionId: string, text: string, steps: Step[], files: Array<{ mime: string; url: string; filename?: string }> = []) {
  model.script(steps)
  const before = model.bodies.length
  await post(server, `/session/${sessionId}/message`, { parts: [{ type: 'text', text }, ...files.map((f) => ({ type: 'file', ...f }))], model: { providerID: PROVIDER, modelID: MODEL_ID } })
  return model.bodies.slice(before).filter((b) => b.tools?.length)
}

function oracle(log: SessionLog, threadId: string, text: string, body: ChatBody) {
  return compareViews(threadView(log, threadId, TARGET, { next_prompt: text }), normalizeOpenAIChat(body), compareOptionsFor('opencode', log, threadId))
}

/** Every thread's next request after the restore: the root by a prompt, each child resumed through `task`. */
async function nextRequests(b: ReturnType<typeof box>, server: OpenCodeServer, log: SessionLog, prompts: Record<string, string>) {
  const root = log.threads.find((t) => t.parent_thread_id === null)!
  const out: Record<string, ReturnType<typeof oracle>> = {}
  const sent: Record<string, ChatBody> = {}
  const [rootBody] = await prompt(server, b.native(root.thread_id), prompts[root.thread_id]!, [{ text: 'OK' }])
  out[root.thread_id] = oracle(log, root.thread_id, prompts[root.thread_id]!, (sent[root.thread_id] = rootBody!))
  for (const child of log.threads.filter((t) => t !== root)) {
    const text = prompts[child.thread_id]!
    const bodies = await prompt(server, b.native(root.thread_id), 'resume the helper', [{ tool: 'task', args: { description: 'resume', prompt: text, subagent_type: 'general', task_id: b.native(child.thread_id) } }, { text: 'child OK' }, { text: 'parent OK' }])
    out[child.thread_id] = oracle(log, child.thread_id, text, (sent[child.thread_id] = bodies[1]!))
  }
  return { out, sent }
}

/** Restore `log` into a fresh box, check the hash guard, serve, and check every thread's next request. */
async function restoreAndCheck(log: SessionLog, prompts: Record<string, string>, seqMax?: Record<string, number>) {
  const b = box(log.session_id)
  const result = await b.port.restore(log, seqMax)
  const guard = await b.port.changes(result.cursors)
  expect(guard.messages.map((m) => m.message.message_id)).toEqual([])
  expect(guard.tombstones).toEqual([])
  const server = await b.serve()
  // OpenCode at rest changed nothing it was given.
  expect((await b.port.changes(result.cursors)).messages.map((m) => m.message.message_id)).toEqual([])
  return { b, server, result, ...(await nextRequests(b, server, log, prompts)) }
}

const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.v2.json`), 'utf8')) as SessionLog
const prompts = (name: string) => (JSON.parse(readFileSync(join(FIXTURES, `${name}.expected-view.json`), 'utf8')) as { next_prompts: Record<string, string> }).next_prompts

describe('the next request after a restore equals modelView (the 7 golden fixtures)', () => {
  for (const name of NAMES) {
    test(`${name}: every thread, root and sub-agent; the hash guard sends nothing`, async () => {
      const log = load(name)
      const { result, out } = await restoreAndCheck(log, prompts(name))
      expect(Object.keys(out).sort()).toEqual(log.threads.map((t) => t.thread_id).sort())
      for (const [thread, check] of Object.entries(out)) expect(check.diffs, `${name} ${thread}`).toEqual([])
      expect(result.dropped).toEqual({})
    }, 90_000)
  }

  test('golden: the summary, the image bytes and model_text reach the model; the failed attempt does not; the oracle can fail', async () => {
    const log = load('golden')
    const { out, sent } = await restoreAndCheck(log, prompts('golden'))
    const root = log.threads[0]!.thread_id
    const body = JSON.stringify(sent[root]!.messages.filter((m) => (m as { role: string }).role !== 'system'))
    expect(body).toContain('SUMMARY-G: the user created hello.txt containing hi and checked an image.')
    expect(body).toContain(`data:image/png;base64,${FIXTURE_PNG.toString('base64')}`)
    expect(body).toContain('Run the command `false` and report the result.')
    expect(body).not.toContain('Partial answer that failed')
    expect(out[root]!.pass).toBe(true)
    // Negative control: the same request against a log with one changed answer fails.
    const changed = structuredClone(log)
    ;(changed.threads[0]!.messages.find((m) => m.message_id === 'msg_g10')!.blocks[0] as { text: string }).text = 'Something else.'
    expect(oracle(changed, root, prompts('golden')[root]!, sent[root]!).pass).toBe(false)
  }, 90_000)

  test('an assistant text with model_text: the model gets model_text, never the display text (P6.5 review)', async () => {
    const log = load('golden')
    const block = log.threads[0]!.messages.find((m) => m.message_id === 'msg_g10')!.blocks[0] as { text: string; model_text?: string }
    block.model_text = 'MODEL-TEXT-G10: exit status 1.'
    const { out, sent } = await restoreAndCheck(log, prompts('golden'))
    const body = JSON.stringify(sent[log.threads[0]!.thread_id])
    expect(body).toContain('MODEL-TEXT-G10: exit status 1.')
    expect(body).not.toContain(block.text)
    for (const [thread, check] of Object.entries(out)) expect(check.diffs, thread).toEqual([])
  }, 90_000)

  test("reasoning: another model's is lowered to assistant text; the same model's is not", async () => {
    for (const same of [false, true]) {
      const log = load('golden')
      const root = log.threads[0]!
      root.messages.find((m) => m.kind === 'compaction')!.in_context = false // msg_g03 is visible
      if (same) root.messages.find((m) => m.message_id === 'msg_g03')!.model = { provider: PROVIDER, model: MODEL_ID, api: 'openai-chat' }
      const { out, sent } = await restoreAndCheck(log, prompts('golden'))
      const reply = (sent[root.thread_id]!.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('Done.'))
      expect(JSON.stringify(reply?.content)).toBe(JSON.stringify(same ? 'Done.' : 'The file exists now.Done.'))
      expect(out[root.thread_id]!.diffs).toEqual([])
      for (const s of servers.splice(0)) await s.stop()
    }
  }, 120_000)

  test('a running OpenCode (a warm seed) imports without a stop: restore while it serves, then prompt', async () => {
    const log = load('opencode')
    const b = box(log.session_id)
    const server = await b.serve()
    // The seed's own session: the restore leaves only the log in the store.
    const seed = (await post(server, '/session', {})) as { id: string }
    const result = await b.port.restore(log)
    expect(result.dropped).toEqual({})
    expect((await b.port.changes(result.cursors)).messages).toEqual([])
    const sessions = new OpencodeDb(b.dbPath).storeSnapshot()!.sessions.map((s) => s.id)
    expect(sessions).not.toContain(seed.id)
    const { out } = await nextRequests(b, server, log, prompts('opencode'))
    for (const check of Object.values(out)) expect(check.diffs).toEqual([])
  }, 90_000)

  test('a running OpenCode that already served the root: a restore with a different history for it, then the next request is the new history', async () => {
    const log = load('opencode')
    const root = log.threads[0]!
    const first = structuredClone(log)
    ;(first.threads[0]!.messages.find((m) => m.seq === 18)!.blocks.find((x) => x.type === 'text') as { text: string }).text = 'FIRST-HISTORY-ANSWER'
    const b = box(log.session_id)
    await b.port.restore(first)
    const server = await b.serve()
    // OpenCode serves the root once: it has loaded the session, its messages and its event sequence.
    const [served] = await prompt(server, root.thread_id, 'first question', [{ text: 'FIRST-SERVED-ANSWER' }])
    expect(JSON.stringify(served)).toContain('FIRST-HISTORY-ANSWER')
    const result = await b.port.restore(log)
    expect(result.dropped).toEqual({})
    expect((await b.port.changes(result.cursors)).messages).toEqual([])
    const { out, sent } = await nextRequests(b, server, log, prompts('opencode'))
    for (const [thread, check] of Object.entries(out)) expect(check.diffs, thread).toEqual([])
    for (const text of ['FIRST-HISTORY-ANSWER', 'first question', 'FIRST-SERVED-ANSWER']) expect(JSON.stringify(sent[root.thread_id])).not.toContain(text)
  }, 90_000)
})

describe('converted and partial logs (P3 conversions)', () => {
  test('a converted log (fromV1 of the v1 transcript) restores; the attachment the conversion lost is not counted again', async () => {
    for (const name of ['opencode', 'pi'] as const) {
      const converted = fromV1(toV1(load(name)), { harness: name === 'pi' ? 'pi' : 'opencode' })
      expect(converted).toMatchObject({ restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 1 } })
      const { result, out } = await restoreAndCheck(converted, prompts(name))
      for (const [thread, check] of Object.entries(out)) expect(check.diffs, `${name} ${thread}`).toEqual([])
      expect(result.dropped).toEqual({})
      for (const s of servers.splice(0)) await s.stop()
    }
  }, 120_000)

  test('a partial log that lost a visible call input and its cut point: the input counts as dropped, and it is the one difference', async () => {
    const v1 = toV1(load('opencode'))
    const parts = v1.rows.flatMap((r) => r.parts as Array<Record<string, any>>)
    const call = parts.findLast((p) => p.type === 'tool' && p.tool === 'bash')!
    delete call.state.input // the sub-agent's last call: in the model's view
    delete parts.find((p) => p.type === 'compaction')!.tail_start_id
    const partial = fromV1(v1, { harness: 'opencode' })
    expect(partial).toMatchObject({ restore_grade: 'partial', grade_counts: { tool_input: 1, cut_point: 1, attachment: 1 } })
    const { result, out } = await restoreAndCheck(partial, prompts('opencode'))
    expect(result.dropped).toEqual({ tool_input: 1 })
    const [root, child] = partial.threads
    expect(out[root!.thread_id]!.diffs).toEqual([])
    // OpenCode sends `{}` for the input the conversion lost (null in the record).
    expect(out[child!.thread_id]!.diffs).toHaveLength(1)
    const [, expected, actual] = /\n  expected: (.*)\n  actual:   (.*)$/.exec(out[child!.thread_id]!.diffs[0]!)!
    expect(expected!.split('"input":null')).toHaveLength(2)
    expect(expected!.replace('"input":null', '"input":{}')).toBe(actual!)
  }, 90_000)
})

/** JSON with sorted keys: `opencode import` stores a row's keys in its schema's order. */
const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))

/** Every difference between two logs, one line per message field (or thread/session field). */
function logDiff(a: SessionLog, b: SessionLog): string[] {
  const out: string[] = []
  const field = (where: string, x: Record<string, unknown>, y: Record<string, unknown>, skip: string[] = []) => {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (skip.includes(k)) continue
      if (canon(x[k]) !== canon(y[k])) out.push(`${where}.${k}: ${canon(x[k])?.slice(0, 300)} -> ${canon(y[k])?.slice(0, 300)}`)
    }
  }
  field('session', a as never, b as never, ['threads'])
  for (const t of a.threads) {
    const u = b.threads.find((x) => x.thread_id === t.thread_id)
    if (!u) { out.push(`thread ${t.thread_id}: missing`); continue }
    field(`thread ${t.thread_id}`, t as never, u as never, ['messages'])
    for (const m of t.messages) {
      const n = u.messages.find((x) => x.message_id === m.message_id)
      if (!n) out.push(`message ${m.message_id} (${m.role}:${m.kind}): missing`)
      else field(`message ${m.message_id}`, m as never, n as never)
    }
    for (const n of u.messages) if (!t.messages.some((m) => m.message_id === n.message_id)) out.push(`message ${n.message_id} (${n.role}:${n.kind}): added`)
  }
  return out
}

/** What the API holds after the journal posts `changes` on top of `log` (puts replace by id, tombstones remove, new threads join). */
function applyJournal(log: SessionLog, changes: SessionLogChanges): SessionLog {
  const out = structuredClone(log)
  for (const t of changes.threads) if (!out.threads.some((x) => x.thread_id === t.thread_id)) out.threads.push({ ...t, messages: [] })
  for (const { message } of changes.messages) {
    const thread = out.threads.find((t) => t.thread_id === message.thread_id)!
    thread.messages = [...thread.messages.filter((m) => m.message_id !== message.message_id), message].sort((a, b) => a.seq - b.seq)
  }
  for (const id of changes.tombstones) for (const t of out.threads) t.messages = t.messages.filter((m) => m.message_id !== id)
  return out
}

/** Seqs of the messages `changes` holds that the restore did not write, per thread. */
const freshSeqs = (changes: SessionLogChanges, cursors: Array<{ thread_id: string; native_hashes: Record<string, string> }>, thread: string) =>
  changes.messages.filter((m) => m.message.thread_id === thread && !(m.message.message_id in (cursors.find((c) => c.thread_id === thread)?.native_hashes ?? {}))).map((m) => m.message.seq)

// Not the 1x1 PNG kortixd's attachment offload uses as its placeholder: the export reads that one as no bytes.
const PNG = FIXTURE_PNG
const TASK = { tool: 'task', args: { description: 'Write the note', prompt: 'write sub.txt', subagent_type: 'general' } }

describe('an OpenCode session recorded here, restored into a fresh box', () => {
  test('image, bash, a sub-agent, a compaction and a stopped call: round trip, hash guard, oracle, the seq rule', async () => {
    const sessionId = 'sess-oc-restore-live'
    const recorded = box(sessionId)
    const live = await recorded.serve()
    const { id: rootId } = (await post(live, '/session', {})) as { id: string }
    await prompt(live, rootId, 'what is this', [{ text: 'an image' }], [{ mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}`, filename: 'shot.png' }])
    await prompt(live, rootId, 'list the files', [{ tool: 'bash', args: { command: 'printf a > a.txt && ls', description: 'list' } }, { text: 'listed' }])
    await prompt(live, rootId, 'spawn a helper', [TASK, { tool: 'bash', args: { command: 'printf sub > sub.txt', description: 'write' } }, { text: 'child wrote sub.txt' }, { text: 'parent done' }])
    model.script([{ text: 'SUMMARY-ONE: an image, a listing and a helper.' }])
    await post(live, `/session/${rootId}/summarize`, { providerID: PROVIDER, modelID: MODEL_ID })
    // A call stopped while it runs: OpenCode records the stop; the reply cut after it is aborted.
    model.script([{ tool: 'bash', args: { command: 'sleep 20', description: 'wait' } }])
    await post(live, `/session/${rootId}/prompt_async`, { parts: [{ type: 'text', text: 'wait for it' }], model: { providerID: PROVIDER, modelID: MODEL_ID } })
    const running = async () => JSON.stringify(await (await fetch(`${live.url}/session/${rootId}/message`)).json()).includes('"status":"running"')
    for (let i = 0; i < 200 && !(await running()); i++) await Bun.sleep(50)
    await post(live, `/session/${rootId}/abort`, {})
    for (let i = 0; i < 200 && (await running()); i++) await Bun.sleep(50)
    await prompt(live, rootId, 'after the stop', [{ text: 'after' }])
    await live.stop()

    const { log } = openCodeSessionLog({ sessionId, rootId, store: new OpencodeDb(recorded.dbPath).storeSnapshot()!, seqs: {} })
    expect(() => upcast(log)).not.toThrow()
    expect(log.threads).toHaveLength(2)
    expect(log.threads[0]!.messages.some((m) => m.kind === 'compaction')).toBe(true)
    expect(log.threads[0]!.messages.some((m) => m.status === 'aborted')).toBe(true)

    const b = box(sessionId, async (ref) => (ref === `blob:${sha(PNG)}` ? PNG : null))
    const result = await b.port.restore(log)
    expect(result.dropped).toEqual({})
    expect(readOpenCodeSessionPin()).toBe(rootId)
    // Round trip: the restored store exports the same log.
    const again = openCodeSessionLog({ sessionId, rootId, store: new OpencodeDb(b.dbPath).storeSnapshot()!, seqs: JSON.parse(readFileSync(b.statePath, 'utf8')).threads })
    expect(logDiff(log, again.log)).toEqual([])
    const server = await b.serve()
    expect((await b.port.changes(result.cursors)).messages).toEqual([])

    const { out } = await nextRequests(b, server, log, Object.fromEntries(log.threads.map((t) => [t.thread_id, 'Anything else?'])))
    for (const [thread, check] of Object.entries(out)) expect(check.diffs, thread).toEqual([])
    // The view: the summary (OpenCode 1.18.23 keeps no tail on a manual compaction), the stopped call with its result, the turn after.
    expect(out[rootId]!.expected.map((x) => x.role[0]).join('')).toBe('suatuau')
    expect(JSON.stringify(out[rootId]!.expected)).toContain('Userabortedthecommand')
    // The seq rule after a restore: every message OpenCode appends numbers above every restored seq.
    const after = await b.port.changes(result.cursors)
    for (const cursor of result.cursors) {
      const fresh = freshSeqs(after, result.cursors, cursor.thread_id)
      expect(fresh.length).toBeGreaterThan(0)
      expect(Math.min(...fresh)).toBeGreaterThan(cursor.last_seq)
      expect(new Set(fresh).size).toBe(fresh.length)
    }
  }, 120_000)
})

describe('tool-call input key order (P6 follow-up)', () => {
  /** What a jsonb column does to an object: keys sorted by length, then bytes. */
  const jsonbSorted = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1)))
  const ARGS = { description: 'print ok', command: 'printf ok' }
  const callBytes = (body: ChatBody) =>
    (body.messages as Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>).flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.arguments))

  test('the next request after a restore carries the call input bytes of the original request; a jsonb-sorted input does not', async () => {
    const sessionId = 'sess-oc-restore-key-order'
    const recorded = box(sessionId)
    const live = await recorded.serve()
    const { id: rootId } = (await post(live, '/session', {})) as { id: string }
    // The first prompt also asks for a title (a request without tools); the call goes in the second.
    await prompt(live, rootId, 'hello', [{ text: 'hi' }, { text: 'Title' }])
    await prompt(live, rootId, 'run it', [{ tool: 'bash', args: ARGS }, { text: 'ran' }])
    const [originalBody] = await prompt(live, rootId, 'Anything else?', [{ text: 'OK' }])
    await live.stop()
    const original = callBytes(originalBody!)
    expect(original).toEqual([JSON.stringify(ARGS)])

    const { log } = openCodeSessionLog({ sessionId, rootId, store: new OpencodeDb(recorded.dbPath).storeSnapshot()!, seqs: {} })
    const nextRequest = async (restoredLog: SessionLog) => {
      const b = box(sessionId)
      await b.port.restore(restoredLog)
      const [body] = await prompt(await b.serve(), b.native(rootId), 'Anything else?', [{ text: 'OK' }])
      return callBytes(body!)
    }
    expect(await nextRequest(log)).toEqual(original)
    // The control: the input as a jsonb column returns it changes the bytes (the prompt-cache miss P6.6 measured).
    const sorted = structuredClone(log)
    for (const t of sorted.threads) for (const m of t.messages) for (const b of m.blocks) if (b.type === 'tool_call') b.input = jsonbSorted(b.input as Record<string, unknown>)
    const missed = await nextRequest(sorted)
    expect(missed).toHaveLength(1)
    expect(missed).not.toEqual(original)
  }, 60_000)
})

describe('a second restore and the seq floor', () => {
  test('restore, a turn journaled under the restored root, restore again: one root, the oracle passes', async () => {
    const log = load('opencode')
    const rootId = log.threads.find((t) => t.parent_thread_id === null)!.thread_id
    const first = box(log.session_id)
    const r1 = await first.port.restore(log)
    const s1 = await first.serve()
    expect(readOpenCodeSessionPin()).toBe(rootId)
    await prompt(s1, rootId, 'One more question.', [{ text: 'One more answer.' }])
    const api = applyJournal(log, await first.port.changes(r1.cursors))
    expect(api.threads.filter((t) => t.parent_thread_id === null).map((t) => t.thread_id)).toEqual([rootId])
    await s1.stop()

    const second = box(log.session_id)
    const r2 = await second.port.restore(api)
    expect(r2.dropped).toEqual({})
    expect(r2.cursors.map((c) => c.thread_id).sort()).toEqual(api.threads.map((t) => t.thread_id).sort())
    expect(readOpenCodeSessionPin()).toBe(rootId)
    const s2 = await second.serve()
    const [body] = await prompt(s2, rootId, 'Anything else?', [{ text: 'OK' }])
    expect(oracle(api, rootId, 'Anything else?', body!).diffs).toEqual([])
    expect(JSON.stringify(body)).toContain('One more answer.')
    // OpenCode's store holds one parentless session.
    expect(new OpencodeDb(second.dbPath).storeSnapshot()!.sessions.filter((s) => !s.parent_id).map((s) => s.id)).toEqual([rootId])
  }, 120_000)

  test('new messages number above every seq the API holds: an unwritten trailing context record, a tombstone (seq_max)', async () => {
    const log = load('golden')
    const [root, child] = log.threads
    const context = structuredClone(root!.messages[0]!)
    Object.assign(context, { message_id: 'msg_ctx_tail', seq: 60, role: 'system', kind: 'context' })
    root!.messages.push(context)
    const b = box(log.session_id)
    const result = await b.port.restore(log, { [root!.thread_id]: 50, [child!.thread_id]: 40 })
    const server = await b.serve()
    await prompt(server, root!.thread_id, 'root turn', [{ text: 'root answer' }])
    await prompt(server, root!.thread_id, 'resume', [{ tool: 'task', args: { description: 'resume', prompt: 'child turn', subagent_type: 'general', task_id: child!.thread_id } }, { text: 'child answer' }, { text: 'parent answer' }])
    const changes = await b.port.changes(result.cursors)
    expect(Math.min(...freshSeqs(changes, result.cursors, root!.thread_id))).toBeGreaterThan(60)
    expect(freshSeqs(changes, result.cursors, child!.thread_id).length).toBeGreaterThan(0)
    expect(Math.min(...freshSeqs(changes, result.cursors, child!.thread_id))).toBeGreaterThan(40)
  }, 90_000)
})

describe('a crash between the import and the end of the restore', () => {
  test('the seq and id state is already on disk: the next export keeps the log seqs and ids, and issues above the floor', async () => {
    const log = load('claude-code') // uuid thread ids: re-keyed, so the state holds ids
    const floor = Object.fromEntries(log.threads.map((t) => [t.thread_id, 100]))
    const b = box(log.session_id)
    // The pin write fails after the import: the restore stops there.
    mkdirSync(join(b.root, 'state', 'opencode-session-id'), { recursive: true })
    await expect(b.port.restore(log, floor)).rejects.toThrow()
    expect(new OpencodeDb(b.dbPath).storeSnapshot()!.sessions.length).toBe(log.threads.length)
    const state = JSON.parse(readFileSync(b.statePath, 'utf8')) as { threads: Record<string, { next: number }>; ids?: Record<string, string> }
    expect(Object.keys(state.ids ?? {}).length).toBeGreaterThan(0)
    for (const t of log.threads) expect(state.threads[t.thread_id]!.next).toBe(101)
    // A daemon that starts on this store (a fresh port): records carry the log's ids and seqs.
    const root = b.native(log.threads[0]!.thread_id)
    expect(root).not.toBe(log.threads[0]!.thread_id)
    const port = createOpenCodeSessionLogPort({ db: new OpencodeDb(b.dbPath), dbPath: b.dbPath, sessionId: log.session_id, rootId: () => root, statePath: b.statePath })
    const { messages } = await port.changes([])
    expect(messages.length).toBeGreaterThan(0)
    const seqOf = new Map(log.threads.flatMap((t) => t.messages.map((m) => [`${t.thread_id}\0${m.message_id}`, m.seq] as const)))
    for (const { message } of messages) {
      expect(log.threads.map((t) => t.thread_id)).toContain(message.thread_id)
      const want = seqOf.get(`${message.thread_id}\0${message.message_id}`)
      if (want !== undefined) expect(message.seq).toBe(want)
      else expect(message.seq).toBeGreaterThan(100)
    }
  }, 60_000)
})

/** A one-turn log of another harness: a user message and an assistant reply with `blocks`. */
function tinyLog(user: SessionLog['threads'][number]['messages'][number]['blocks'], reply: SessionLog['threads'][number]['messages'][number]['blocks']): SessionLog {
  const at = '2026-10-13T00:00:00.000Z'
  const producer = { harness: 'pi', harness_version: '1.0.3', adapter_version: '1.0.0' }
  const base = { schema: 'kortix.session/2', v: 1, thread_id: 'ses_drop', model: null, usage: null, error: null, created_at: at, completed_at: at, producer, status: 'complete', in_context: true, kind: 'turn' } as const
  return {
    schema: 'kortix.session/2', v: 1, session_id: 'sess-drop', title: null, created_at: at, restore_grade: 'native',
    harness: { current: 'pi', history: [] }, selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] },
    threads: [{
      schema: 'kortix.session/2', v: 1, thread_id: 'ses_drop', parent_thread_id: null, spawned_by: null, agent: null, title: null, created_at: at,
      messages: [
        { ...base, message_id: 'msg_d1', seq: 1, role: 'user', finish: null, blocks: [{ type: 'text', id: 'prt_d10', text: 'hello' }, ...user] },
        { ...base, message_id: 'msg_d2', seq: 2, role: 'assistant', finish: 'stop', blocks: [...reply, { type: 'text', id: 'prt_d29', text: 'done' }] },
      ],
    }],
  } as unknown as SessionLog
}

describe('what the restore cannot write counts in dropped', () => {
  const ref = `blob:${sha(FIXTURE_PNG)}`
  const image = { type: 'attachment', id: 'prt_d11', mime: 'image/png', ref, bytes: FIXTURE_PNG.length, sha256: sha(FIXTURE_PNG) }
  const cases: Array<[string, SessionLog, (ref: string) => Promise<Buffer | null>, Record<string, number>]> = [
    // Closure rule C2: a call at rest has a result. A log that breaks it writes an error part and counts the loss.
    ['a call without a result', tinyLog([], [{ type: 'tool_call', id: 'prt_d20', call_id: 'call_d', name: 'bash', kind: 'shell', input: { command: 'ls' }, status: 'complete' } as never]), async () => null, { tool_result: 1 }],
    // A text the restore answer could not read in full (`truncated`): its preview goes out.
    ['a text still stored by reference', tinyLog([{ type: 'text', id: 'prt_d11', text: 'PREVIEW', ref: 'kortix-attachment://p/s/o', bytes: 300_000 } as never], []), async () => null, { text: 1 }],
    ['an attachment without bytes', tinyLog([image as never], []), async () => null, { attachment: 1 }],
    ['an attachment whose bytes do not match its sha256', tinyLog([image as never], []), async () => Buffer.from('tampered'), { attachment: 1 }],
  ]
  for (const [name, log, read, dropped] of cases) {
    test(`${name}: ${JSON.stringify(dropped)}`, async () => {
      const b = box(log.session_id, read)
      const result = await b.port.restore(log)
      expect(result.dropped).toEqual(dropped)
      // The rest is written: the hash guard holds over the whole store.
      expect((await b.port.changes(result.cursors)).messages).toEqual([])
      expect(new OpencodeDb(b.dbPath).storeSnapshot()!.messages.length).toBe(2)
    }, 30_000)
  }
})

describe('a pi session restored into OpenCode (a harness switch)', () => {
  test('one root under the pi root id; pi part ids are re-keyed and map back; the oracle passes', async () => {
    const sessionId = 'sess-pi-to-oc'
    const home = mkdtempSync(join(tmpdir(), 'pi-origin-'))
    dirs.push(home)
    const absent = join(tmpdir(), 'pi-origin-absent-box-state')
    Object.assign(process.env, { HOME: home, KORTIX_MANAGED_SKILLS_DIR: absent, KORTIX_PT_ENV_PATH: absent })
    writeFileSync(join(home, 'catalog.json'), JSON.stringify({ models: { [MODEL_ID]: { name: 'Test Model', attachment: true, limit: { context: 64_000, output: 4_096 } } } }))
    mkdirSync(join(home, '.state'), { recursive: true })
    const env: NodeJS.ProcessEnv = {
      KORTIX_HARNESS: 'pi', KORTIX_LLM_BASE_URL: model.url, KORTIX_LLM_CATALOG_FILE: join(home, 'catalog.json'),
      KORTIX_PI_STATE_DIR: join(home, '.state'), KORTIX_PI_AGENT_DIR: join(home, '.pi-agent'), KORTIX_PI_PACKAGES_DIR: join(home, '.pi-packages'),
      KORTIX_PROJECT_AUTO_CLONE: '0', KORTIX_WORKSPACE: home, KORTIX_PROJECT_TARGET: home, KORTIX_TOKEN: 'dummy-not-a-real-key',
      KORTIX_SESSION_ID: sessionId, KORTIX_PROJECT_ID: 'proj-pi-to-oc', KORTIX_PI_TURN_RETRY_BASE_MS: '5',
    }
    const service = createPiHarnessService(requirePiConfig(loadConfig(env)), undefined, { env })
    services.push(service)
    await service.lifecycle.start()
    const rt = service.runtime()!
    const turn = async (text: string, steps: Step[], files: Array<{ mime: string; url: string; filename?: string }> = []) => {
      model.script(steps)
      expect(await rt.admit({ text, files }).done).toBe('completed')
    }
    await turn('what is this', [{ text: 'an image' }], [{ mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}`, filename: 'shot.png' }])
    await turn('list the files', [{ tool: 'bash', args: { command: 'printf a > a.txt && ls' } }, { text: 'listed' }])
    await turn('spawn a helper', [{ tool: 'task', args: { description: 'Write the note', prompt: 'write sub.txt', subagent_type: 'general' } }, { tool: 'bash', args: { command: 'printf sub > sub.txt' } }, { text: 'child wrote sub.txt' }, { text: 'parent done' }])
    const { log } = piSessionLog(rt.sessionLogSnapshot()!)
    await service.lifecycle.stop()
    services.splice(0)
    const root = log.threads.find((t) => t.parent_thread_id === null)!
    expect(root.thread_id).toStartWith('ses_pi')

    const b = box(sessionId, async (ref) => (ref === `blob:${sha(PNG)}` ? PNG : null))
    const result = await b.port.restore(log)
    // The image bytes live only in pi's store (`blob:`); this reader has them.
    expect(result.dropped).toEqual({})
    // One root forever: OpenCode runs under the pi root id.
    expect(readOpenCodeSessionPin()).toBe(root.thread_id)
    expect(b.native(root.thread_id)).toBe(root.thread_id)
    expect((await b.port.changes(result.cursors)).messages).toEqual([])
    const server = await b.serve()
    const { out } = await nextRequests(b, server, log, Object.fromEntries(log.threads.map((t) => [t.thread_id, 'Anything else?'])))
    for (const [thread, check] of Object.entries(out)) expect(check.diffs, thread).toEqual([])
    // The journal after the switch: new messages only, under the log's thread ids.
    const after = await b.port.changes(result.cursors)
    expect(after.messages.length).toBeGreaterThan(0)
    for (const m of after.messages) expect(log.threads.map((t) => t.thread_id)).toContain(m.message.thread_id)
    expect(after.tombstones).toEqual([])
  }, 120_000)
})

describe('one import for every thread: the store equals one import per thread', () => {
  /** The restore's write before the single import: one `opencode import` per session file. */
  const importEach = async (target: OpenCodeRestoreTarget, files: Array<Record<string, any>>, dir: string) => {
    for (const [i, f] of files.entries()) {
      const path = join(dir, `each-${i}.json`)
      writeFileSync(path, JSON.stringify(f))
      const proc = Bun.spawn([target.bin, '--pure', 'import', path], { cwd: target.cwd, env: { ...target.env, OPENCODE_DB: target.dbPath }, stdout: 'pipe', stderr: 'pipe' })
      expect(await new Response(proc.stdout).text()).toContain(`Imported session: ${f.info.id}`)
    }
  }
  /** Every session, message and part row; write-time columns (`time_updated`, a part's `time_created`) left out, JSON parsed. */
  const rows = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true })
    try {
      const read = (sql: string, drop: string[]) =>
        (db.query(sql).all() as Array<Record<string, unknown>>).map((r) =>
          Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v])),
        )
      return {
        sessions: read('SELECT * FROM session ORDER BY id', []),
        messages: read('SELECT * FROM message ORDER BY session_id, time_created, id', ['time_updated']),
        parts: read('SELECT * FROM part ORDER BY session_id, message_id, id', ['time_updated', 'time_created']),
        // Every other table keyed by session: its row count per session.
        keyed: Object.fromEntries(
          (db.query("SELECT m.name FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT IN ('session', 'message', 'part') AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE name = 'session_id')").all() as Array<{ name: string }>)
            .map(({ name }) => [name, db.query(`SELECT session_id, count(*) AS n FROM "${name}" GROUP BY session_id ORDER BY session_id`).all()]),
        ),
      }
    } finally {
      db.close()
    }
  }
  /** pi's log plus two clones of its sub-agent, each spawned by a clone of the spawning reply at the root's end: 4 threads. */
  const fourThreads = () => {
    const log = load('pi')
    const [root, child] = log.threads as [SessionLog['threads'][number], SessionLog['threads'][number]]
    const spawn = root.messages.find((m) => m.message_id === child.spawned_by!.message_id)!
    const ids = [child.thread_id, spawn.message_id, child.spawned_by!.call_id, ...child.messages.flatMap((m) => [m.message_id, ...m.blocks.flatMap((b) => ('call_id' in b && b.call_id ? [b.call_id] : []))])]
    const renamed = <T,>(v: T, k: number): T => {
      let json = JSON.stringify(v)
      for (const id of ids) json = json.replaceAll(`"${id}"`, `"${id}x${k}"`)
      return JSON.parse(json) as T
    }
    const top = Math.max(...root.messages.map((m) => m.seq))
    for (const k of [1, 2]) {
      root.messages.push({ ...renamed(spawn, k), seq: top + k })
      log.threads.push(renamed(child, k))
    }
    return log
  }
  async function compare(log: SessionLog, url?: string) {
    const b = box(log.session_id)
    const target = { bin, cwd: b.workspace, env: b.env, dbPath: b.dbPath, sessionId: log.session_id, statePath: b.statePath, readAttachment: async (ref: string) => blobs.get(ref) ?? null }
    if (url === 'serve') url = (await b.serve()).url
    const one = await restoreOpenCodeSessionLog(log, { ...target, url })
    const single = rows(b.dbPath)
    const other = await restoreOpenCodeSessionLog(log, target, {}, importEach)
    return { b, single, each: rows(b.dbPath), one, other }
  }

  for (const name of NAMES) {
    test(`${name}: the same session, message and part rows, and the same cursors`, async () => {
      const { single, each, one, other } = await compare(load(name))
      expect(single.sessions).toHaveLength(load(name).threads.length)
      expect(single).toEqual(each)
      // A native hash digests the part rows' write times: the cursors match up to the hash values.
      const shape = (r: typeof one) => ({ dropped: r.dropped, cursors: r.cursors.map((c) => ({ ...c, native_hashes: Object.keys(c.native_hashes) })) })
      expect(shape(one)).toEqual(shape(other))
    }, 60_000)
  }

  test('4 threads (three sub-agents) restored while OpenCode serves, its version from its health: equal rows; a moved or dropped thread fails the comparison', async () => {
    const log = fourThreads()
    const { b, single, each, one } = await compare(log, 'serve')
    expect(single.sessions).toHaveLength(4)
    expect(single.sessions.filter((s) => s.parent_id === null)).toHaveLength(1)
    expect(new Set(single.sessions.map((s) => s.version))).toEqual(new Set([OPENCODE_VERSION]))
    expect(single).toEqual(each)
    expect(one.cursors.map((c) => c.thread_id)).toEqual(log.threads.map((t) => t.thread_id))
    for (const t of log.threads) expect(single.messages.filter((m) => m.session_id === b.native(t.thread_id)).length, t.thread_id).toBeGreaterThan(0)
    // Negative controls: one message under another thread, or a thread gone, is a different store.
    const db = new Database(b.dbPath)
    const [root, , second] = log.threads.map((t) => b.native(t.thread_id))
    const moved = db.query('SELECT id FROM message WHERE session_id = ? LIMIT 1').get(second!) as { id: string }
    db.run('UPDATE message SET session_id = ? WHERE id = ?', [root!, moved.id])
    expect(rows(b.dbPath)).not.toEqual(each)
    db.run('UPDATE message SET session_id = ? WHERE id = ?', [second!, moved.id])
    expect(rows(b.dbPath)).toEqual(each)
    db.run('PRAGMA foreign_keys = ON')
    db.run('DELETE FROM session WHERE id = ?', [second!])
    db.close()
    expect(rows(b.dbPath)).not.toEqual(each)
  }, 90_000)

  test('a row left on the holding session fails the restore before the delete could cascade it; the store keeps no root', async () => {
    const log = load('opencode')
    const b = box(log.session_id)
    const target = { bin, cwd: b.workspace, env: b.env, dbPath: b.dbPath, sessionId: log.session_id, statePath: b.statePath }
    await restoreOpenCodeSessionLog(log, target)
    // The holding session's id (see importSessions); a trigger gives it a todo, a row the move does not know.
    const hold = `ses_${createHash('sha256').update(`hold\0${b.native(log.threads[0]!.thread_id)}`).digest('hex').slice(0, 26)}`
    const db = new Database(b.dbPath)
    db.run(`CREATE TRIGGER leftover AFTER INSERT ON session WHEN NEW.id = '${hold}' BEGIN INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (NEW.id, 'x', 'pending', 'low', 0, 0, 0); END`)
    db.close()
    await expect(restoreOpenCodeSessionLog(log, target)).rejects.toThrow('the restore left 1 row(s) of todo on the holding session')
    const after = rows(b.dbPath)
    expect(after.sessions.map((s) => s.id)).toEqual([hold])
    expect(new Set(after.messages.map((m) => m.session_id))).toEqual(new Set([hold]))
    expect(after.keyed.todo).toEqual([{ session_id: hold, n: 1 }])
  }, 60_000)

  test('4 threads: the next request of every thread equals modelView', async () => {
    const log = fourThreads()
    const base = prompts('pi')
    const texts = Object.fromEntries(log.threads.map((t, i) => [t.thread_id, base[t.thread_id] ?? `continue thread ${i}`]))
    const { out } = await restoreAndCheck(log, texts)
    expect(Object.keys(out).sort()).toEqual(log.threads.map((t) => t.thread_id).sort())
    for (const [thread, check] of Object.entries(out)) expect(check.diffs, thread).toEqual([])
  }, 120_000)
})

describe('the boot reconcile on OpenCode (P6.4)', () => {
  const PROJECT = 'proj-oc-restore'
  /** golden, its image stored by the API (a `kortix-attachment://` object the box reads). */
  const storedImage = () => {
    const log = load('golden')
    const image = log.threads[0]!.messages.find((m) => m.message_id === 'msg_g04')!.blocks.find((b) => b.type === 'attachment') as { ref: string }
    image.ref = `kortix-attachment://${PROJECT}/${log.session_id}/img-1`
    return log
  }
  const objects = new Map([['img-1', FIXTURE_PNG]])
  const restores = (api: ReturnType<typeof fakeSessionLogApi>) => api.calls.filter((c) => c === 'POST log/restore').length
  const ids = (log: SessionLog) => log.threads.flatMap((t) => t.messages.map((m) => m.message_id))
  afterEach(() => resetSessionLogJournalForTests())

  test('held: null without a store, without the pinned root or without the seq map; a reverted message stays held', async () => {
    const log = load('golden')
    const b = box(log.session_id)
    expect(await b.port.held()).toBeNull()
    await b.port.restore(log)
    const held = await b.port.held()
    expect([...held!].sort()).toEqual(ids(log).sort())
    // OpenCode deletes a reverted message; until the journal tombstones it, the store did hold it.
    const db = new Database(b.dbPath)
    db.run('PRAGMA foreign_keys = ON')
    db.run("DELETE FROM message WHERE id = 'msg_g14'")
    db.close()
    expect((await b.port.held())!.has('msg_g14')).toBe(true)
    writeOpenCodeSessionPin('ses_not_in_the_store')
    expect(await b.port.held()).toBeNull()
    writeOpenCodeSessionPin(log.threads[0]!.thread_id)
    expect(await b.port.held()).not.toBeNull()
    rmSync(b.statePath)
    expect(await b.port.held()).toBeNull()
  }, 60_000)

  test('no native state: the box restores, the next request equals modelView; after a restart the store is current; a turn not yet journaled is kept', async () => {
    const log = storedImage()
    const rootId = log.threads[0]!.thread_id
    const b = box(log.session_id)
    const api = fakeSessionLogApi(log, { projectId: PROJECT, stateDir: join(b.root, 'state'), objects })
    try {
      const boot = (await reconcileSessionLog(b.port, { retryMs: 1 }))!
      expect(api.calls).toEqual(['GET log/manifest', 'POST log/restore', 'GET attachments/img-1'])
      expect(boot.generation).toBe(1)
      expect(boot.session).toBeUndefined()
      startSessionLogJournal(b.port, boot)
      expect(await flushSessionLogJournal()).toBe(true)
      // The journal at the claimed generation sends nothing back: every restored record is skipped by hash.
      expect(api.journal.flatMap((x) => x.puts)).toEqual([])
      // P7.1: the log's harness (`fixture`) stays in the history; OpenCode serves the session from the first root seq after the restore.
      expect(api.journal.find((x) => x.session?.harness)?.session?.harness).toEqual({
        current: 'opencode',
        history: [...log.harness.history, { harness: 'opencode', version: expect.any(String), from_seq: Math.max(...log.threads[0]!.messages.map((m) => m.seq)) + 1, at: boot.harness!.at }],
      })
      const server = await b.serve()
      const [body] = await prompt(server, rootId, 'Anything else?', [{ text: 'UNSENT-ANSWER' }])
      expect(oracle(log, rootId, 'Anything else?', body!).diffs).toEqual([])
      expect(JSON.stringify(body)).toContain(FIXTURE_PNG.toString('base64'))
      // The turn is in the store, not in the API (no flush ran): the store is ahead, never behind.
      resetSessionLogJournalForTests()
      expect(await reconcileSessionLog(b.port, { retryMs: 1 })).toEqual({ generation: 1, cursors: [], harness: boot.harness })
      expect(restores(api)).toBe(1)
      expect((await b.port.held())!.size).toBeGreaterThan(ids(log).length)
    } finally {
      api.stop()
    }
  }, 60_000)

  test('stale native state (a store from before the last turns) is restored', async () => {
    const log = storedImage()
    const rootId = log.threads[0]!.thread_id
    const b = box(log.session_id)
    const older = structuredClone(log)
    older.threads[0]!.messages = older.threads[0]!.messages.slice(0, -2)
    await b.port.restore(older)
    const api = fakeSessionLogApi(log, { projectId: PROJECT, stateDir: join(b.root, 'state'), objects })
    try {
      expect((await reconcileSessionLog(b.port, { retryMs: 1 }))?.generation).toBe(1)
      expect(restores(api)).toBe(1)
      const server = await b.serve()
      const [body] = await prompt(server, rootId, 'Anything else?', [{ text: 'OK' }])
      expect(oracle(log, rootId, 'Anything else?', body!).diffs).toEqual([])
    } finally {
      api.stop()
    }
  }, 60_000)

  test('a partial restore (D3): the agent gets a note in its next request and the log, the user a partial session patch', async () => {
    // golden as stored: its image is a `blob:` the box cannot read through the API.
    const log = load('golden')
    const rootId = log.threads[0]!.thread_id
    const b = box(log.session_id)
    const api = fakeSessionLogApi(log, { projectId: PROJECT, stateDir: join(b.root, 'state') })
    try {
      const boot = (await reconcileSessionLog(b.port, { retryMs: 1 }))!
      expect(boot.session).toMatchObject({ restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 1 } })
      startSessionLogJournal(b.port, boot)
      expect(await flushSessionLogJournal()).toBe(true)
      expect(api.journal.flatMap((x) => x.puts.map((p) => p.message.blocks[0]?.id))).toEqual(['prt_kortix_restore_g1'])
      expect(api.journal[0]!.session).toMatchObject({ restore_grade: 'partial' })
      expect(api.stored().threads[0]!.messages.at(-1)).toMatchObject({ role: 'user', origin: 'notification', in_context: true, seq: 15, blocks: [{ id: 'prt_kortix_restore_g1' }] })
      const expected = structuredClone(api.stored())
      const g04 = expected.threads[0]!.messages.find((m) => m.message_id === 'msg_g04')!
      g04.blocks = g04.blocks.filter((x) => x.type !== 'attachment')
      const server = await b.serve()
      const [body] = await prompt(server, rootId, 'Anything else?', [{ text: 'OK' }])
      expect(JSON.stringify(body)).toContain('Kortix: this session was restored from its saved session log. Some earlier content could not be restored: 1 attachment.')
      expect(oracle(expected, rootId, 'Anything else?', body!).diffs).toEqual([])
    } finally {
      api.stop()
    }
  }, 60_000)

  test('P2.13: the journal stores a prompt image, a prompt PDF and a tool-result image; a fresh box restores them with nothing dropped', async () => {
    const sessionId = 'sess-oc-blobs'
    const empty: SessionLog = {
      schema: 'kortix.session/2', v: 1, session_id: sessionId, title: null, created_at: '2026-10-15T00:00:00.000Z', restore_grade: 'native',
      harness: { current: 'opencode', history: [] }, selection: { agent: null, model: null }, todos: [], pending: { questions: [], permissions: [] }, threads: [],
    }
    // Synthetic files: a 1x1 PNG with the prompt, a minimal PDF, and a 2x2 PNG a tool reads from disk (not the 1x1 offload placeholder).
    const shot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgaPgPQhAKACX2Bf2gcp/LAAAAAElFTkSuQmCC', 'base64')
    const pdf = Buffer.from('%PDF-1.4\n% synthetic\n%%EOF\n')
    const a = box(sessionId)
    writeFileSync(join(a.workspace, 'shot.png'), shot)
    const api = fakeSessionLogApi(empty, { projectId: PROJECT, stateDir: join(a.root, 'state') })
    try {
      const live = await a.serve()
      const { id: rootId } = (await post(live, '/session', {})) as { id: string }
      writeOpenCodeSessionPin(rootId)
      startSessionLogJournal(a.port, { generation: 0 })
      await prompt(live, rootId, 'what are these', [{ text: 'an image and a pdf' }], [
        { mime: 'image/png', url: `data:image/png;base64,${FIXTURE_PNG.toString('base64')}`, filename: 'prompt.png' },
        { mime: 'application/pdf', url: `data:application/pdf;base64,${pdf.toString('base64')}`, filename: 'notes.pdf' },
      ])
      await prompt(live, rootId, 'read the screenshot', [{ tool: 'read', args: { filePath: join(a.workspace, 'shot.png') } }, { text: 'a pixel' }])
      expect(await flushSessionLogJournal()).toBe(true)
      await live.stop()
      resetSessionLogJournalForTests()

      const own = `kortix-attachment://${PROJECT}/${sessionId}/`
      const messages = api.stored().threads.flatMap((t) => t.messages)
      const files = messages.flatMap((m) => m.blocks.filter((x) => x.type === 'attachment'))
      expect(files.map((x) => [x.mime, x.ref, x.sha256, x.bytes])).toEqual([
        ['image/png', `${own}blob-${sha(FIXTURE_PNG)}`, sha(FIXTURE_PNG), FIXTURE_PNG.length],
        ['application/pdf', `${own}blob-${sha(pdf)}`, sha(pdf), pdf.length],
      ])
      const toolFiles = messages.flatMap((m) => m.blocks.flatMap((x) => (x.type === 'tool_call' ? (x.result?.content ?? []).filter((c) => c.type === 'attachment') : [])))
      expect(toolFiles).toEqual([{ type: 'attachment', ref: `${own}blob-${sha(shot)}`, mime: 'image/png', sha256: sha(shot) }])
      expect([...api.objects.keys()].sort()).toEqual([sha(FIXTURE_PNG), sha(pdf), sha(shot)].map((x) => `blob-${x}`).sort())

      // A fresh box restores the stored log: every object read back, nothing dropped, the next request carries them.
      const b = box(sessionId)
      const boot = (await reconcileSessionLog(b.port, { retryMs: 1 }))!
      expect(boot.generation).toBe(1)
      expect(boot.session).toBeUndefined()
      expect(api.calls.filter((c) => c.startsWith('GET attachments/')).length).toBe(3)
      const server = await b.serve()
      const [body] = await prompt(server, b.native(rootId), 'Anything else?', [{ text: 'OK' }])
      const sent = JSON.stringify(body)
      for (const bytes of [FIXTURE_PNG, pdf, shot]) expect(sent).toContain(bytes.toString('base64'))
      expect(oracle(api.stored(), rootId, 'Anything else?', body!).diffs).toEqual([])
    } finally {
      api.stop()
    }
  }, 90_000)
})
