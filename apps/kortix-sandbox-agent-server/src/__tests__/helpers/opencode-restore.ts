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
 *
 * Shared by the opencode-session-log-restore-*.test.ts files. The suite is
 * split so `bun test --parallel` spreads its OpenCode boots across workers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { compareOptionsFor, compareViews, normalizeOpenAIChat, threadView, type SessionLog, type ViewTarget } from '@kortix/api-contract/session-log'
import type { SessionLogChanges, SessionLogPort } from '@/harness/contract/session-log'
import { OpencodeDb } from '@/harness/open-code/opencode-db'
import { readOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import { createOpenCodeSessionLogPort, OPENCODE_CAPABILITIES } from '@/harness/open-code/session-log'
import { type PiHarnessService } from '@/harness/pi/service'
import { resetKortixEventBusForTests } from '@/services/event-bus/kortix-event-bus'
import { startFakeModel, type ChatBody, type Step } from './fake-model'
import { openCodeBin, openCodeBox, PROVIDER, type OpenCodeServer } from './opencode-box'

export const FIXTURES = join(import.meta.dir, '../../../../../packages/api-contract/src/__tests__/fixtures/session-log')
export const NAMES = ['golden', 'golden21', 'pi', 'opencode', 'opencode-v2', 'claude-code', 'codex'] as const
/** The fixtures' one image (`blob:<sha256>`): a synthetic 1x1 PNG. */
export const FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
export const blobs = new Map([[`blob:${sha(FIXTURE_PNG)}`, FIXTURE_PNG]])
export const MODEL_ID = 'test-model'
export const TARGET: ViewTarget = { provider: PROVIDER, model: MODEL_ID, reasoning_replay: OPENCODE_CAPABILITIES.native.reasoning_replay }

export let model: ReturnType<typeof startFakeModel>
export let bin: string
export const servers: OpenCodeServer[] = []
export const services: PiHarnessService[] = []
export const dirs: string[] = []
export const saved: Record<string, string | undefined> = {}
/** The fake model, the OpenCode binary, and per-test cleanup of boxes, servers and env. Call once at the top of each test file. */
export function useRestoreHarness() {
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
}

/** A fresh OpenCode box; its runtime state dir (pin, seq map) becomes the daemon's. */
export function box(sessionId: string, readAttachment: (ref: string) => Promise<Buffer | null> = async (ref) => blobs.get(ref) ?? null) {
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

export async function post(server: OpenCodeServer, path: string, body: unknown) {
  const res = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : ((await res.json()) as any)
}

/** One prompt to an OpenCode session; returns the agent requests it sent (title requests have no tools). */
export async function prompt(server: OpenCodeServer, sessionId: string, text: string, steps: Step[], files: Array<{ mime: string; url: string; filename?: string }> = []) {
  model.script(steps)
  const before = model.bodies.length
  await post(server, `/session/${sessionId}/message`, { parts: [{ type: 'text', text }, ...files.map((f) => ({ type: 'file', ...f }))], model: { providerID: PROVIDER, modelID: MODEL_ID } })
  return model.bodies.slice(before).filter((b) => b.tools?.length)
}

export function oracle(log: SessionLog, threadId: string, text: string, body: ChatBody) {
  return compareViews(threadView(log, threadId, TARGET, { next_prompt: text }), normalizeOpenAIChat(body), compareOptionsFor('opencode', log, threadId))
}

/** Every thread's next request after the restore: the root by a prompt, each child resumed through `task`. */
export async function nextRequests(b: ReturnType<typeof box>, server: OpenCodeServer, log: SessionLog, prompts: Record<string, string>) {
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
export async function restoreAndCheck(log: SessionLog, prompts: Record<string, string>, seqMax?: Record<string, number>) {
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

export const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.v2.json`), 'utf8')) as SessionLog
export const prompts = (name: string) => (JSON.parse(readFileSync(join(FIXTURES, `${name}.expected-view.json`), 'utf8')) as { next_prompts: Record<string, string> }).next_prompts


/** JSON with sorted keys: `opencode import` stores a row's keys in its schema's order. */
export const canon = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))

/** Every difference between two logs, one line per message field (or thread/session field). */
export function logDiff(a: SessionLog, b: SessionLog): string[] {
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
export function applyJournal(log: SessionLog, changes: SessionLogChanges): SessionLog {
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
export const freshSeqs = (changes: SessionLogChanges, cursors: Array<{ thread_id: string; native_hashes: Record<string, string> }>, thread: string) =>
  changes.messages.filter((m) => m.message.thread_id === thread && !(m.message.message_id in (cursors.find((c) => c.thread_id === thread)?.native_hashes ?? {}))).map((m) => m.message.seq)

// Not the 1x1 PNG kortixd's attachment offload uses as its placeholder: the export reads that one as no bytes.
export const PNG = FIXTURE_PNG
export const TASK = { tool: 'task', args: { description: 'Write the note', prompt: 'write sub.txt', subagent_type: 'general' } }

/** A one-turn log of another harness: a user message and an assistant reply with `blocks`. */
export function tinyLog(user: SessionLog['threads'][number]['messages'][number]['blocks'], reply: SessionLog['threads'][number]['messages'][number]['blocks']): SessionLog {
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

