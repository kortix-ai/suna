// The OpenCode writer on an over-cap restore (`kept: 'model_view'`): each thread arrives cut to
// `modelViewSliceIds`. The next request OpenCode sends for every thread equals modelView of the WHOLE
// log: OpenCode's compaction pair (`tail_start_id`), a summary + tail and a `layout` compaction.
import { describe, expect, test } from 'bun:test'
import { modelViewSliceIds, type SessionLog } from '@kortix/api-contract/session-log'
import { useRestoreHarness, load, oracle, prompts, restoreAndCheck } from './helpers/opencode-restore'

useRestoreHarness()

const cut = (log: SessionLog): SessionLog => ({
  ...log,
  threads: log.threads.map((t) => {
    const keep = modelViewSliceIds(t.messages)
    return { ...t, messages: t.messages.filter((m) => keep.has(m.message_id)) }
  }),
})

describe('OpenCode writes a model_view slice: the next request equals modelView of the whole log', () => {
  for (const name of ['opencode', 'golden', 'codex'] as const) {
    test(`${name}: every thread`, async () => {
      const whole = load(name)
      const sliced = cut(whole)
      expect(sliced.threads.flatMap((t) => t.messages).length).toBeLessThan(whole.threads.flatMap((t) => t.messages).length)
      const seqMax = Object.fromEntries(whole.threads.map((t) => [t.thread_id, Math.max(0, ...t.messages.map((m) => m.seq))]))
      const { sent } = await restoreAndCheck(sliced, prompts(name), seqMax)
      for (const t of whole.threads) expect(oracle(whole, t.thread_id, prompts(name)[t.thread_id]!, sent[t.thread_id]!).diffs, t.thread_id).toEqual([])
    }, 90_000)
  }
})
