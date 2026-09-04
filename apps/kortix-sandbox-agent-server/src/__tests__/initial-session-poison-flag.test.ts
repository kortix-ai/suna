import { describe, expect, test } from 'bun:test'
import { finalizeInitialSession } from '../main'

describe('initial opencode session failure is not permanent', () => {
  // proxy.ts:345 returns 503 initial_opencode_session_failed on this flag and
  // health.ts folds it into runtimeReady=false. It was written in two places
  // and cleared in none, so one throwing attempt of the retry ladder wedged
  // the box for the life of the sandbox -- only a real Restart healed it.
  test('a successful later attempt clears the stamped error', async () => {
    const bootState = {
      initialOpenCodeSessionError: 'ECONNREFUSED on attempt 1',
      initialOpenCodeSessionId: null as string | null,
      initialOpenCodeSessionRequired: true,
    }

    finalizeInitialSession(bootState, 'ses_root_abc')

    expect(bootState.initialOpenCodeSessionId).toBe('ses_root_abc')
    expect(bootState.initialOpenCodeSessionError).toBeNull()
  })
})
