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
import { readOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import { createOpenCodeSessionLogPort, OPENCODE_CAPABILITIES, openCodeSessionLog } from '@/harness/open-code/session-log'
import { requirePiConfig } from '@/harness/pi/config'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { piSessionLog } from '@/harness/pi/session-log'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { startFakeModel, type ChatBody, type Step } from './helpers/fake-model'
import { openCodeBin, openCodeBox, PROVIDER, type OpenCodeServer } from './helpers/opencode-box'

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
    expect(out[child!.thread_id]!.diffs[0]).toContain('"input":null')
    expect(out[child!.thread_id]!.diffs[0]).toContain('"input":{}')
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
