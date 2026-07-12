import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { relayTurnEndToApi, __resetRelayedTurnSignatures } from '../main'
import type { Config } from '../config'

// Exactly-once finalize for a completed turn. Proves the fast-boot event-loss
// fix's dedup invariant: whether a turn's end is observed by the natural
// session.idle, the reconcile-on-subscribe backstop, or a duplicate idle from
// opencode, the turn-end is relayed to apps/api EXACTLY ONCE. A genuinely new
// turn (new completed timestamp) relays again.

const ROOT = 'ses_root'
const WORKSPACE = '/workspace'

// Minimal opencode + apps/api mock. opencode: GET /session/:id (root, no
// parentID) and GET /session/:id/message (last assistant message with a
// completed timestamp we control). apps/api: POST .../turn-stream counts calls.
function startMocks(getCompletedAt: () => number, turnStreamOk: () => boolean = () => true) {
  let turnStreamCalls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      // apps/api turn-stream relay target.
      if (url.pathname.endsWith('/turn-stream')) {
        turnStreamCalls++
        // A non-ok response simulates a transient apps/api outage: the daemon
        // retries, then gives up WITHOUT recording the dedup signature.
        if (!turnStreamOk()) return new Response('boom', { status: 503 })
        return Response.json({ ok: true })
      }
      // opencode: message list for the root turn — one completed assistant reply.
      if (url.pathname === `/session/${ROOT}/message`) {
        return Response.json([
          { info: { role: 'user' } },
          { info: { role: 'assistant', time: { completed: getCompletedAt() } } },
        ])
      }
      // opencode: session lookup — root has no parentID.
      if (url.pathname === `/session/${ROOT}`) {
        return Response.json({ parentID: null })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls: () => turnStreamCalls,
    stop: () => server.stop(true),
  }
}

let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  __resetRelayedTurnSignatures()
  saved = {
    SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID,
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

function slackEnv(apiUrl: string) {
  process.env.SLACK_CHANNEL_ID = 'C123'
  process.env.KORTIX_PROJECT_ID = 'proj_1'
  process.env.KORTIX_SESSION_ID = 'sess_1'
  process.env.KORTIX_SANDBOX_TOKEN = 'tok'
  process.env.KORTIX_API_URL = apiUrl
}

describe('relayTurnEndToApi — exactly-once per completed turn', () => {
  test('two idle relays for the SAME completed turn finalize once', async () => {
    let completedAt = 1000
    const m = startMocks(() => completedAt)
    slackEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      // Natural session.idle AND reconcile-on-subscribe observe the same turn.
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg)
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg)
      expect(m.calls()).toBe(1)
    } finally {
      m.stop()
    }
  })

  test('a NEW turn (new completed timestamp) relays again', async () => {
    let completedAt = 1000
    const m = startMocks(() => completedAt)
    slackEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg) // turn 1
      completedAt = 2000 // a second turn completes on the same session
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg) // turn 2
      expect(m.calls()).toBe(2)
    } finally {
      m.stop()
    }
  })

  test('no-op outside Slack (no relay context)', async () => {
    const m = startMocks(() => 1000)
    // deliberately NOT calling slackEnv → no SLACK_* env
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg)
      expect(m.calls()).toBe(0)
    } finally {
      m.stop()
    }
  })

  // Transient-outage backstop: a relay that FAILS all retries must NOT record the
  // dedup signature, so a later observation of the SAME completed turn (e.g. the
  // reconcile-on-subscribe backstop) can still finalize it. Records only on res.ok.
  test('a failed relay does not suppress a later successful relay of the same turn', async () => {
    let ok = false // first relay attempt(s) hit a 503 outage
    const m = startMocks(() => 1000, () => ok)
    slackEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg) // fails all 4 retries → sig NOT recorded
      const afterFail = m.calls()
      expect(afterFail).toBe(4) // 4 retry attempts, all 503
      ok = true // apps/api recovers
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg) // same turn — MUST relay (not suppressed)
      expect(m.calls()).toBe(afterFail + 1)
      // Now it's recorded on success → a third observation is a no-op.
      await relayTurnEndToApi(ROOT, 'idle', opencode, cfg)
      expect(m.calls()).toBe(afterFail + 1)
    } finally {
      m.stop()
    }
  }, 15_000)
})
