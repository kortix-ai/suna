/**
 * Reconcile-on-subscribe must not end a turn that a steer is still running.
 *
 * After a steer (R10) the turn's next step is parented on the STEERED message,
 * not on the message that opened the turn. `readRootTurnState` reads a
 * different parent as a different turn, so an event-stream reconnect inside
 * that step found the step before the steer "completed" and relayed `end`.
 * Measured 2026-10-10 on a local stack: the reconnect came 1.2 s after the
 * steer was read, the API closed the turn, and the agent worked on for 90 s
 * with the session shown idle.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetRelayedTurnSignatures, reconcileFinishedFirstTurn } from '@/harness/open-code/boot'
import type { OpenCodeConfig as Config } from '@/harness/open-code/config'
import { writeOpenCodeSessionPin } from '@/harness/open-code/runtime-state'
import { resetSessionTokenHealthForTests } from '@/lib/kortix-api/session-token-health'

const ROOT = 'ses_root'
const STEERED_TURN = [
  { info: { id: 'msg_turn', role: 'user' } },
  { info: { role: 'assistant', parentID: 'msg_turn', time: { completed: 1000 } } },
  { info: { id: 'msg_steer', role: 'user' } },
  { info: { role: 'assistant', parentID: 'msg_steer', time: {} } },
]

function startMocks(status: Record<string, unknown>) {
  const ends: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/turn-stream')) {
        ends.push((await req.json()) as Record<string, unknown>)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/session/status') return Response.json(status)
      if (url.pathname === `/session/${ROOT}/message`) return Response.json(STEERED_TURN)
      if (url.pathname === `/session/${ROOT}`) return Response.json({ parentID: null })
      return new Response('not found', { status: 404 })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}`, ends, stop: () => server.stop(true) }
}

const savedEnv = { ...process.env }
let stateDir: string
beforeEach(() => {
  __resetRelayedTurnSignatures()
  resetSessionTokenHealthForTests()
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-steer-reconcile-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
  writeOpenCodeSessionPin(ROOT)
})
afterEach(() => {
  resetSessionTokenHealthForTests()
  process.env = { ...savedEnv }
  rmSync(stateDir, { recursive: true, force: true })
})

async function reconcile(status: Record<string, unknown>) {
  const m = startMocks(status)
  Object.assign(process.env, {
    KORTIX_PROJECT_ID: 'proj_1',
    KORTIX_SESSION_ID: 'sess_1',
    KORTIX_TOKEN: 'tok',
    KORTIX_API_URL: m.baseUrl,
  })
  try {
    await reconcileFinishedFirstTurn({ getInternalUrl: () => m.baseUrl }, { workspace: '/workspace' } as unknown as Config)
    return m.ends
  } finally {
    m.stop()
  }
}

test('a busy root relays no end, though the step before the steer reads completed', async () => {
  expect(await reconcile({ [ROOT]: { type: 'busy' } })).toEqual([])
})

test('an idle root still relays the end the transcript proves', async () => {
  const ends = await reconcile({})
  expect(ends).toHaveLength(1)
  expect(ends[0]).toMatchObject({ kind: 'end', status: 'idle', turn_message_id: 'msg_turn' })
})
