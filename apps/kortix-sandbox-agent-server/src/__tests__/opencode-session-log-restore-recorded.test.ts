// The OpenCode session-log restore against the oracle: see helpers/opencode-restore.ts.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { upcast, type SessionLog } from '@kortix/api-contract/session-log'
import { OpencodeDb } from '@/harness/open-code/opencode-db'
import { readOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import { openCodeSessionLog } from '@/harness/open-code/session-log'
import { type ChatBody } from './helpers/fake-model'
import { PROVIDER } from './helpers/opencode-box'
import { useRestoreHarness, sha, MODEL_ID, model, box, post, prompt, oracle, nextRequests, logDiff, freshSeqs, PNG, TASK } from './helpers/opencode-restore'

useRestoreHarness()

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
