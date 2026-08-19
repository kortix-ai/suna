import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { relayTurnEndToApi, __resetRelayedTurnSignatures } from '../main'
import { MAX_CONSECUTIVE_REPEATS, __resetRunawayGuardStates } from '../runaway-turn-guard'
import type { Config } from '../config'

// The runaway-turn guard must reach CHILD sessions. Essentia incident
// 2026-08-18 (session 5d9e298a): a spawned sub-session re-answered the same
// parent user message indefinitely. `relayTurnEndToApi` filtered non-root
// sessions out BEFORE the guard ran, so the child looped unbounded while the
// root — idle — was never the session repeating. The guard is per opencode
// session id already; this pins that a child's idle completions feed it and
// that the abort targets THE CHILD, while turn-end relay stays root-only.

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const WORKSPACE = '/workspace'

function startMocks() {
  let turnStreamCalls = 0
  const aborts: string[] = []
  let completedAt = 1000
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/turn-stream')) {
        turnStreamCalls++
        return Response.json({ ok: true })
      }
      const abort = /^\/session\/([^/]+)\/abort$/.exec(url.pathname)
      if (abort && req.method === 'POST') {
        aborts.push(abort[1]!)
        return Response.json({ ok: true })
      }
      // Both sessions: the SAME standing parent, a fresh completed stamp per
      // read so the turn-end dedup does not absorb the repeats.
      if (url.pathname === `/session/${CHILD}/message` || url.pathname === `/session/${ROOT}/message`) {
        completedAt += 1
        return Response.json([
          { info: { id: 'msg_stuck', role: 'user' } },
          { info: { role: 'assistant', parentID: 'msg_stuck', time: { completed: completedAt } } },
        ])
      }
      if (url.pathname === `/session/${CHILD}`) return Response.json({ parentID: ROOT })
      if (url.pathname === `/session/${ROOT}`) return Response.json({ parentID: null })
      return new Response('not found', { status: 404 })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    turnStreamCalls: () => turnStreamCalls,
    aborts,
    stop: () => server.stop(true),
  }
}

let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  __resetRelayedTurnSignatures()
  __resetRunawayGuardStates()
  saved = {
    KORTIX_PROJECT_ID: process.env.KORTIX_PROJECT_ID,
    KORTIX_SESSION_ID: process.env.KORTIX_SESSION_ID,
    KORTIX_SANDBOX_TOKEN: process.env.KORTIX_SANDBOX_TOKEN,
    KORTIX_API_URL: process.env.KORTIX_API_URL,
  }
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function settle() {
  // The guard runs fire-and-forget; give its abort fetch a few turns to land.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10))
}

describe('runaway guard reaches child sessions', () => {
  test('a CHILD re-answering the same standing prompt is aborted — and only the child', async () => {
    const m = startMocks()
    process.env.KORTIX_PROJECT_ID = 'proj_1'
    process.env.KORTIX_SESSION_ID = 'sess_1'
    process.env.KORTIX_SANDBOX_TOKEN = 'tok'
    process.env.KORTIX_API_URL = m.baseUrl
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      for (let i = 0; i <= MAX_CONSECUTIVE_REPEATS; i++) {
        await relayTurnEndToApi(CHILD, 'idle', opencode, cfg)
      }
      await settle()
      expect(m.aborts).toEqual([CHILD])
      // Turn-end relay stays root-only: a child's idle never finalizes the turn.
      expect(m.turnStreamCalls()).toBe(0)
    } finally {
      m.stop()
    }
  })

  test('the root guard is unchanged: root repeats abort the root and relay the turn', async () => {
    const m = startMocks()
    process.env.KORTIX_PROJECT_ID = 'proj_1'
    process.env.KORTIX_SESSION_ID = 'sess_1'
    process.env.KORTIX_SANDBOX_TOKEN = 'tok'
    process.env.KORTIX_API_URL = m.baseUrl
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      for (let i = 0; i <= MAX_CONSECUTIVE_REPEATS; i++) {
        await relayTurnEndToApi(ROOT, 'idle', opencode, cfg)
      }
      await settle()
      expect(m.aborts).toEqual([ROOT])
      expect(m.turnStreamCalls()).toBeGreaterThan(0)
    } finally {
      m.stop()
    }
  })
})
