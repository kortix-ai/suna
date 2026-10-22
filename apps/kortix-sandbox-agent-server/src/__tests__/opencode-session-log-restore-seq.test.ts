// The OpenCode session-log restore against the oracle: see helpers/opencode-restore.ts.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SessionLog } from '@kortix/api-contract/session-log'
import { loadConfig } from '@/harness/harness'
import { OpencodeDb } from '@/harness/open-code/opencode-db'
import { readOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import { createOpenCodeSessionLogPort } from '@/harness/open-code/session-log'
import { requirePiConfig } from '@/harness/pi/config'
import { createPiHarnessService } from '@/harness/pi/service'
import { piSessionLog } from '@/harness/pi/session-log'
import { type Step } from './helpers/fake-model'
import { useRestoreHarness, FIXTURE_PNG, sha, MODEL_ID, model, services, dirs, box, prompt, oracle, nextRequests, load, applyJournal, freshSeqs, PNG, tinyLog } from './helpers/opencode-restore'

useRestoreHarness()

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
