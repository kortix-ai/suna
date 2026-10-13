/**
 * The pi session-log restore (P6.2) against the oracle: a log is restored into a
 * fresh pi state dir, the REAL pi runtime boots on it against a local fake
 * OpenAI-compatible model (dummy key, isolated home), one prompt runs, and the
 * request pi sent must equal `modelView(log)` plus that prompt
 * (`@kortix/api-contract/session-log` `threadView` + `compareViews`, the pi
 * compare options). Sources: the 7 golden fixtures of the 65/65 matrix (root and
 * sub-agent threads; a sub-agent is resumed through `task` with its `task_id`)
 * and a pi session recorded in this file, which also round-trips.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareOptionsFor,
  compareViews,
  normalizeOpenAIChat,
  threadView,
  fromV1,
  toV1,
  upcast,
  type SessionLog,
  type ViewTarget,
} from '@kortix/api-contract/session-log'
import type { SessionLogChanges } from '@/harness/contract/session-log'
import { loadConfig } from '@/harness/harness'
import { requirePiConfig } from '@/harness/pi/config'
import { createPiHarnessService, type PiHarnessService } from '@/harness/pi/service'
import { createPiSessionLogPort, piSessionLog, PI_CAPABILITIES } from '@/harness/pi/session-log'
import { restorePiSessionLog } from '@/harness/pi/session-log-restore'
import type { PiRuntime } from '@/harness/pi/runtime'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { startFakeModel, type Step } from './helpers/fake-model'

const FIXTURES = join(import.meta.dir, '../../../../packages/api-contract/src/__tests__/fixtures/session-log')
const NAMES = ['golden', 'golden21', 'pi', 'opencode', 'opencode-v2', 'claude-code', 'codex'] as const
/** The fixtures' one image (`blob:<sha256>`): a synthetic 1x1 PNG. */
const FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const blobs = new Map([[`blob:${createHash('sha256').update(FIXTURE_PNG).digest('hex')}`, FIXTURE_PNG]])
const MODEL_ID = 'test-model'
const TOKEN = 'dummy-not-a-real-key'

let model: ReturnType<typeof startFakeModel>
let home: string
const saved: Record<string, string | undefined> = {}
const services: PiHarnessService[] = []
const dirs: string[] = []
beforeAll(() => {
  model = startFakeModel(MODEL_ID)
})
afterAll(() => model.stop())
beforeEach(() => {
  resetKortixEventBusForTests()
  home = mkdtempSync(join(tmpdir(), 'pi-restore-home-'))
  dirs.push(home)
  const absent = join(tmpdir(), 'pi-restore-absent-box-state')
  for (const [key, value] of Object.entries({ HOME: home, KORTIX_MANAGED_SKILLS_DIR: absent, KORTIX_PT_ENV_PATH: absent })) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.lifecycle.stop().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetKortixEventBusForTests()
})

/** A fresh workspace and pi home, pointed only at the fake model. */
function freshBox(sessionId: string) {
  const workspace = mkdtempSync(join(tmpdir(), 'pi-restore-box-'))
  dirs.push(workspace)
  // The model reads images; compaction keeps one token so a summary cuts.
  writeFileSync(join(workspace, 'catalog.json'), JSON.stringify({ models: { [MODEL_ID]: { name: 'Test Model', attachment: true, limit: { context: 64_000, output: 4_096 } } } }))
  mkdirSync(join(workspace, 'harnesses/pi'), { recursive: true })
  writeFileSync(join(workspace, 'harnesses/pi/settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 1 } }))
  const env: NodeJS.ProcessEnv = {
    KORTIX_HARNESS: 'pi',
    KORTIX_LLM_BASE_URL: model.url,
    KORTIX_LLM_CATALOG_FILE: join(workspace, 'catalog.json'),
    KORTIX_PI_STATE_DIR: join(workspace, '.state'),
    KORTIX_PI_AGENT_DIR: join(workspace, '.pi-agent'),
    KORTIX_PI_PACKAGES_DIR: join(workspace, '.pi-packages'),
    KORTIX_PROJECT_AUTO_CLONE: '0',
    KORTIX_WORKSPACE: workspace,
    KORTIX_PROJECT_TARGET: workspace,
    KORTIX_TOKEN: TOKEN,
    KORTIX_SESSION_ID: sessionId,
    KORTIX_PROJECT_ID: 'proj-pi-restore',
    KORTIX_PI_TURN_RETRY_BASE_MS: '5',
  }
  const start = async () => {
    const service = createPiHarnessService(requirePiConfig(loadConfig(env)), undefined, { env })
    services.push(service)
    await service.lifecycle.start()
    return service.runtime()!
  }
  return { workspace, stateDir: join(workspace, '.state'), start }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

/** One root turn; returns the request bodies it sent. */
async function turn(rt: PiRuntime, text: string, steps: Step[], files: Array<{ mime: string; url: string; filename?: string }> = []) {
  model.script(steps)
  const before = model.bodies.length
  expect(await rt.admit({ text, files }).done).toBe('completed')
  return model.bodies.slice(before)
}

const target = (rt: PiRuntime): ViewTarget => {
  const selected = rt.selectedModel()!
  return { provider: selected.providerID, model: selected.modelID, reasoning_replay: PI_CAPABILITIES.native.reasoning_replay }
}

/** The oracle: the request pi sent for `threadId` against `modelView(log)` plus `prompt`. */
function oracle(log: SessionLog, threadId: string, rt: PiRuntime, prompt: string, body: { messages: unknown[] }) {
  const expected = threadView(log, threadId, target(rt), { next_prompt: prompt })
  return compareViews(expected, normalizeOpenAIChat(body), compareOptionsFor('pi', log, threadId))
}

/** Restore `log` into a fresh box, boot pi, and check the next request of every thread. */
async function restoreAndCheck(log: SessionLog, prompts: Record<string, string>) {
  const box = freshBox(log.session_id)
  const result = await restorePiSessionLog(log, { stateDir: box.stateDir, sessionId: log.session_id, cwd: box.workspace, readAttachment: async (ref) => blobs.get(ref) ?? null })
  const rt = await box.start()
  const root = log.threads.find((t) => t.parent_thread_id === null)!
  const out: Record<string, { pass: boolean; diffs: string[] }> = {}
  const sent: Record<string, { messages: unknown[] }> = {}
  const [rootBody] = await turn(rt, prompts[root.thread_id]!, [{ text: 'OK' }])
  out[root.thread_id] = oracle(log, root.thread_id, rt, prompts[root.thread_id]!, (sent[root.thread_id] = rootBody!))
  for (const child of log.threads.filter((t) => t !== root)) {
    const prompt = prompts[child.thread_id]!
    // The model resumes the sub-agent with its task_id; its first request is the child's next request.
    const bodies = await turn(rt, 'resume the helper', [{ tool: 'task', args: { description: 'resume', prompt, subagent_type: 'general', task_id: child.thread_id } }, { text: 'child OK' }, { text: 'parent OK' }])
    out[child.thread_id] = oracle(log, child.thread_id, rt, prompt, (sent[child.thread_id] = bodies[1]!))
  }
  return { result, out, sent }
}

const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.v2.json`), 'utf8')) as SessionLog
const prompts = (name: string) => (JSON.parse(readFileSync(join(FIXTURES, `${name}.expected-view.json`), 'utf8')) as { next_prompts: Record<string, string> }).next_prompts

describe('the next request after a restore equals modelView (the 7 golden fixtures)', () => {
  for (const name of NAMES) {
    test(`${name}: every thread, root and sub-agent`, async () => {
      const log = load(name)
      const { result, out } = await restoreAndCheck(log, prompts(name))
      expect(Object.keys(out).sort()).toEqual(log.threads.map((t) => t.thread_id).sort())
      for (const [thread, check] of Object.entries(out)) expect(check.diffs, `${name} ${thread}`).toEqual([])
      expect(result.dropped).toEqual({})
    }, 60_000)
  }

  test('golden: the request holds the summary, the image bytes and model_text; the failed attempt never reaches the model', async () => {
    const log = load('golden')
    const box = freshBox(log.session_id)
    await restorePiSessionLog(log, { stateDir: box.stateDir, sessionId: log.session_id, cwd: box.workspace, readAttachment: async (ref) => blobs.get(ref) ?? null })
    const rt = await box.start()
    const [body] = await turn(rt, 'Anything else?', [{ text: 'OK' }])
    const sent = JSON.stringify(body!.messages.filter((m) => (m as { role: string }).role !== 'system'))
    expect(sent).toContain('<summary>\\nSUMMARY-G: the user created hello.txt containing hi and checked an image.\\n</summary>')
    expect(sent).toContain(`data:image/png;base64,${FIXTURE_PNG.toString('base64')}`)
    // msg_g07 shows `/check`; the model got the expanded text (model_text).
    expect(sent).toContain('Run the command `false` and report the result.')
    // msg_g08 is a failed attempt (`in_context: false`) inside the kept range.
    expect(sent).not.toContain('Partial answer that failed')
    // The oracle is not blind: the same request against a log with one changed answer fails.
    const changed = structuredClone(log)
    ;(changed.threads[0]!.messages.find((m) => m.message_id === 'msg_g10')!.blocks[0] as { text: string }).text = 'Something else.'
    expect(oracle(changed, log.threads[0]!.thread_id, rt, 'Anything else?', body!).pass).toBe(false)
  }, 60_000)

  test('golden21: the interrupted call goes out with its closure result', async () => {
    const log = load('golden21')
    const { out, sent } = await restoreAndCheck(log, prompts('golden21'))
    expect(Object.values(out).every((c) => c.pass)).toBe(true)
    expect(JSON.stringify(sent[log.threads[0]!.thread_id])).toContain('[interrupted]')
  }, 60_000)

  test('reasoning: another model\'s is lowered to assistant text; the same model\'s stays reasoning', async () => {
    for (const same of [false, true]) {
      const log = load('golden')
      const root = log.threads[0]!
      root.messages.find((m) => m.kind === 'compaction')!.in_context = false // msg_g03 is visible
      if (same) root.messages.find((m) => m.message_id === 'msg_g03')!.model = { provider: 'kortix', model: MODEL_ID, api: 'openai-chat' }
      const box = freshBox(log.session_id)
      await restorePiSessionLog(log, { stateDir: box.stateDir, sessionId: log.session_id, cwd: box.workspace, readAttachment: async (ref) => blobs.get(ref) ?? null })
      const rt = await box.start()
      const [body] = await turn(rt, 'x', [{ text: 'OK' }])
      const reply = (body!.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('Done.'))
      // pi-ai joins the lowered thinking and the text with no separator.
      expect(reply?.content).toBe(same ? 'Done.' : 'The file exists now.Done.')
      expect(oracle(log, root.thread_id, rt, 'x', body!).diffs).toEqual([])
      for (const service of services.splice(0)) await service.lifecycle.stop()
    }
  }, 60_000)
})

describe('converted and partial logs (P3 conversions, OpenCode-origin sessions)', () => {
  test('a converted log (fromV1 of the v1 transcript) restores; the attachment the conversion lost is not counted again', async () => {
    for (const name of ['opencode', 'pi'] as const) {
      const converted = fromV1(toV1(load(name)), { harness: name === 'pi' ? 'pi' : 'opencode' })
      expect(converted).toMatchObject({ restore_grade: 'partial', grade_counts: { tool_input: 0, cut_point: 0, attachment: 1 } })
      const { result, out } = await restoreAndCheck(converted, prompts(name))
      for (const check of Object.values(out)) expect(check.diffs).toEqual([])
      expect(result.dropped).toEqual({})
      for (const service of services.splice(0)) await service.lifecycle.stop()
    }
  }, 60_000)

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
    // pi sends `{}` for the input the conversion lost (null in the record).
    expect(out[child!.thread_id]!.diffs).toHaveLength(1)
    expect(out[child!.thread_id]!.diffs[0]).toContain('"input":null')
    expect(out[child!.thread_id]!.diffs[0]).toContain('"input":{}')
  }, 60_000)
})

/** Every difference between two logs, one line per message field (or thread/session field). */
function logDiff(a: SessionLog, b: SessionLog): string[] {
  const out: string[] = []
  const field = (where: string, x: Record<string, unknown>, y: Record<string, unknown>, skip: string[] = []) => {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (skip.includes(k)) continue
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out.push(`${where}.${k}: ${JSON.stringify(x[k])?.slice(0, 160)} -> ${JSON.stringify(y[k])?.slice(0, 160)}`)
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

describe('a pi session recorded here, restored into a fresh box', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  const TASK = { tool: 'task', args: { description: 'Write the note', prompt: 'write sub.txt', subagent_type: 'general' } }

  test('4 turns with an image, bash, a sub-agent, a compaction and an interrupted call: round trip, hash guard and oracle', async () => {
    const sessionId = 'sess-pi-restore-live'
    const recorded = freshBox(sessionId)
    const rt = await recorded.start()
    await turn(rt, 'what is this', [{ text: 'an image' }], [{ mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}`, filename: 'shot.png' }])
    await turn(rt, 'list the files', [{ tool: 'bash', args: { command: 'printf a > a.txt && ls' } }, { text: 'listed' }])
    await turn(rt, 'spawn a helper', [TASK, { tool: 'bash', args: { command: 'printf sub > sub.txt' } }, { text: 'child wrote sub.txt' }, { text: 'parent done' }])
    model.script([{ text: 'SUMMARY-ONE: an image, a listing and a helper.' }])
    rt.compact()
    await waitFor(() => rt.idle())
    // A call stopped while it runs: pi records its own error result; the reply cut after it is out of context.
    model.script([{ tool: 'bash', args: { command: 'sleep 20' } }])
    const stopped = rt.admit({ text: 'wait for it', files: [] })
    await waitFor(() => rt.transcript.all().some((m) => m.parts.some((p) => p.type === 'tool' && (p as { state?: { status?: string } }).state?.status === 'running')))
    await rt.abort()
    await stopped.done
    await turn(rt, 'after the stop', [{ text: 'after' }])

    const { log, hashes } = piSessionLog(rt.sessionLogSnapshot()!)
    expect(() => upcast(log)).not.toThrow()
    const root = log.threads[0]!
    expect(root.messages.some((m) => m.kind === 'compaction')).toBe(true)
    expect(log.threads).toHaveLength(2)

    const box = freshBox(sessionId)
    const result = await restorePiSessionLog(log, { stateDir: box.stateDir, sessionId, cwd: box.workspace, readAttachment: async (ref) => (ref === `blob:${createHash('sha256').update(PNG).digest('hex')}` ? PNG : null) })
    expect(result.dropped).toEqual({})
    const restored = await box.start()

    // The hash guard: the booted runtime's export holds exactly the hashes restore returned, so the journal sends nothing.
    const again = piSessionLog(restored.sessionLogSnapshot()!)
    for (const c of result.cursors) for (const [id, hash] of Object.entries(c.native_hashes)) expect(again.hashes.get(id), id).toBe(hash)
    expect([...again.hashes.keys()].sort()).toEqual(result.cursors.flatMap((c) => Object.keys(c.native_hashes)).sort())
    const port = createPiSessionLogPort(() => restored.sessionLogSnapshot())
    const next = await port.changes(result.cursors)
    expect(next.messages).toEqual([])
    expect(next.tombstones).toEqual([])

    // Round trip: the one difference is pi's system prompt (`context`), which pi rebuilds from config at the next prompt.
    const contexts = log.threads.flatMap((t) => t.messages.filter((m) => m.kind === 'context'))
    expect(contexts.map((m) => m.role)).toEqual(['system', 'system'])
    expect(logDiff(log, again.log)).toEqual(contexts.map((m) => `message ${m.message_id} (system:context): missing`))
    expect(hashes.size).toBe(again.hashes.size + contexts.length)

    // The oracle on the root and on the sub-agent, which `task_id` resumes.
    const [rootBody] = await turn(restored, 'Anything else?', [{ text: 'OK' }])
    const rootCheck = oracle(log, root.thread_id, restored, 'Anything else?', rootBody!)
    const child = log.threads[1]!
    const bodies = await turn(restored, 'resume the helper', [{ tool: 'task', args: { ...TASK.args, prompt: 'Anything else?', task_id: child.thread_id } }, { text: 'child OK' }, { text: 'parent OK' }])
    const childCheck = oracle(log, child.thread_id, restored, 'Anything else?', bodies[1]!)
    expect(rootCheck.diffs).toEqual([])
    expect(childCheck.diffs).toEqual([])
    // The seq rule after a restore: every message pi appends numbers above every restored seq, in order.
    const after = await port.changes(result.cursors)
    for (const thread of after.threads) {
      const cursor = result.cursors.find((c) => c.thread_id === thread.thread_id)!
      const fresh = after.messages.filter((m) => m.message.thread_id === thread.thread_id && !(m.message.message_id in cursor.native_hashes)).map((m) => m.message.seq)
      expect(fresh.length).toBeGreaterThan(0)
      expect(Math.min(...fresh)).toBeGreaterThan(cursor.last_seq)
      expect(fresh).toEqual([...fresh].sort((a, b) => a - b))
      expect(new Set(fresh).size).toBe(fresh.length)
    }
    // The view held the compaction summary, the kept turns and the stopped call.
    expect(rootCheck.expected.map((x) => x.role[0]).join('')).toBe('sauatuau')
  }, 60_000)
})

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

describe('a second restore (P6.2 review)', () => {
  test('an OpenCode-origin log: restore, a turn journaled under the restored root, restore again: one root, the oracle passes', async () => {
    const log = load('opencode')
    const rootId = log.threads.find((t) => t.parent_thread_id === null)!.thread_id
    const first = freshBox(log.session_id)
    const r1 = await restorePiSessionLog(log, { stateDir: first.stateDir, sessionId: log.session_id, cwd: first.workspace, readAttachment: async (ref) => blobs.get(ref) ?? null })
    const rt1 = await first.start()
    // pi runs under the log's root: one root, forever.
    expect(rt1.rootId).toBe(rootId)
    await turn(rt1, 'One more question.', [{ text: 'One more answer.' }])
    const api = applyJournal(log, await createPiSessionLogPort(() => rt1.sessionLogSnapshot()).changes(r1.cursors))
    expect(api.threads.filter((t) => t.parent_thread_id === null).map((t) => t.thread_id)).toEqual([rootId])
    for (const service of services.splice(0)) await service.lifecycle.stop()

    const second = freshBox(log.session_id)
    const r2 = await restorePiSessionLog(api, { stateDir: second.stateDir, sessionId: log.session_id, cwd: second.workspace, readAttachment: async (ref) => blobs.get(ref) ?? null })
    expect(r2.dropped).toEqual({})
    expect(r2.cursors.map((c) => c.thread_id).sort()).toEqual(api.threads.map((t) => t.thread_id).sort())
    const rt2 = await second.start()
    expect(rt2.rootId).toBe(rootId)
    const [body] = await turn(rt2, 'Anything else?', [{ text: 'OK' }])
    const check = oracle(api, rootId, rt2, 'Anything else?', body!)
    expect(check.diffs).toEqual([])
    // The turn after the switch is in the model's context.
    expect(JSON.stringify(body)).toContain('One more answer.')
  }, 60_000)
})

describe('the seq floor (P6.2 review)', () => {
  test('new messages number above every seq the API holds: an unwritten context record, a tombstone (seq_max)', async () => {
    const log = load('golden')
    const [root, child] = log.threads
    // A trailing context record: in the log, never written to pi.
    const context = structuredClone(root!.messages[0]!)
    Object.assign(context, { message_id: 'msg_ctx_tail', seq: 60, role: 'system', kind: 'context' })
    root!.messages.push(context)
    // seq_max: the child's thread holds a tombstone at 40 (not in the log).
    const box = freshBox(log.session_id)
    const result = await restorePiSessionLog(log, { stateDir: box.stateDir, sessionId: log.session_id, cwd: box.workspace, readAttachment: async (ref) => blobs.get(ref) ?? null }, { [root!.thread_id]: 50, [child!.thread_id]: 40 })
    const rt = await box.start()
    await turn(rt, 'root turn', [{ text: 'root answer' }])
    await turn(rt, 'resume', [{ tool: 'task', args: { description: 'resume', prompt: 'child turn', subagent_type: 'general', task_id: child!.thread_id } }, { text: 'child answer' }, { text: 'parent answer' }])
    const changes = await createPiSessionLogPort(() => rt.sessionLogSnapshot()).changes(result.cursors)
    const fresh = (thread: string) => changes.messages.filter((m) => m.message.thread_id === thread && !(m.message.message_id in result.cursors.find((c) => c.thread_id === thread)!.native_hashes)).map((m) => m.message.seq)
    expect(fresh(root!.thread_id).length).toBeGreaterThan(0)
    expect(Math.min(...fresh(root!.thread_id))).toBeGreaterThan(60)
    expect(fresh(child!.thread_id).length).toBeGreaterThan(0)
    expect(Math.min(...fresh(child!.thread_id))).toBeGreaterThan(40)
  }, 60_000)
})
