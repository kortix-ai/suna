// The OpenCode session-log restore against the oracle: see helpers/opencode-restore.ts.
import { describe, expect, test } from 'bun:test'
import { useRestoreHarness, NAMES, restoreAndCheck, load, prompts } from './helpers/opencode-restore'

useRestoreHarness()

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
})
