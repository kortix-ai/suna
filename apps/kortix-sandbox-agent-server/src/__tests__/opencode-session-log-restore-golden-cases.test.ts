// The OpenCode session-log restore against the oracle: see helpers/opencode-restore.ts.
import { describe, expect, test } from 'bun:test'
import { fromV1, toV1 } from '@kortix/api-contract/session-log'
import { OpencodeDb } from '@/harness/open-code/opencode-db'
import { PROVIDER } from './helpers/opencode-box'
import { useRestoreHarness, FIXTURE_PNG, MODEL_ID, model, servers, box, post, prompt, oracle, nextRequests, restoreAndCheck, load, prompts } from './helpers/opencode-restore'

useRestoreHarness()

describe('the next request after a restore equals modelView (the 7 golden fixtures)', () => {
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
