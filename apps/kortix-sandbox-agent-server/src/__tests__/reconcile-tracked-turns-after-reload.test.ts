import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { startOpencodeEventLoop } from '../opencode-events'
import {
  __resetRelayedTurnBegins,
  __resetRelayedTurnSignatures,
  reconcileFinishedFirstTurn,
  reconcileFinishedTrackedTurns,
  relayTurnBeginToApi,
  relayTurnEndToApi,
} from '../main'
import { __resetTrackedRootTurnSessions, trackRootTurnSession, trackedRootTurnSessions } from '../turn-tracking'
import type { Config } from '../config'
import type { Opencode } from '../opencode'

// Live 2026-08-23 (session eddd499a, first prompt "yo?!"): a pre-prompt env
// push replaced OpenCode; the prompt reached the NEW process before the daemon's
// /event loop re-subscribed to it; the turn finished in ~5s inside that gap; its
// session.idle was emitted to nobody; the ledger turn stayed `active` for 80+s.
//
// The fix: on EVERY (re)subscribe — and on the periodic reconcile — ask OpenCode
// about every root a turn was observed on (not only the boot-pinned root) and
// relay a synthetic `end` for each one that is idle with a completed reply.
// `relayTurnEndToApi` dedups per completed turn, so this is idempotent.

const S = 'ses_reloaded_turn'
const PINNED = 'ses_pinned_root'
const WORKSPACE = '/workspace'

type MockOpencodeState = {
  busy: Set<string>
  completedAt: Map<string, number | null>
  userMessageId: Map<string, string>
}

/** A mock OpenCode process: /event SSE (keepalive only, no replay), /session/status,
 *  /session/:id, /session/:id/message. `stop()` kills it like SIGTERM does. */
function startMockOpencode(state: MockOpencodeState) {
  let subscribes = 0
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/event') {
        subscribes++
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(':ok\n\n'))
          },
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.pathname === '/session/status') {
        const out: Record<string, { type: string }> = {}
        for (const id of state.busy) out[id] = { type: 'busy' }
        return Response.json(out)
      }
      const m = /^\/session\/([^/]+)(\/message)?$/.exec(url.pathname)
      if (m && !m[2]) return Response.json({ id: m[1], parentID: null })
      if (m && m[2]) {
        const id = m[1]!
        const completed = state.completedAt.get(id) ?? null
        const userId = state.userMessageId.get(id) ?? `msg_user_${id}`
        return Response.json([
          { info: { id: userId, role: 'user' } },
          {
            info: {
              id: `msg_asst_${id}`,
              role: 'assistant',
              parentID: userId,
              ...(completed == null ? {} : { time: { completed } }),
            },
          },
        ])
      }
      return new Response('nf', { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    subscribes: () => subscribes,
    stop: () => server.stop(true),
  }
}

function startMockApi() {
  const ends: Array<Record<string, unknown>> = []
  const begins: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith('/turn-stream')) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        if (body.kind === 'end') ends.push(body)
        if (body.kind === 'turn_begin') begins.push(body)
        return Response.json({ ok: true, outcome: 'adopted' })
      }
      return new Response('nf', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, ends, begins, stop: () => server.stop(true) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  __resetRelayedTurnSignatures()
  __resetRelayedTurnBegins()
  __resetTrackedRootTurnSessions()
  saved = {
    KORTIX_PROJECT_ID: process.env.KORTIX_PROJECT_ID,
    KORTIX_SESSION_ID: process.env.KORTIX_SESSION_ID,
    KORTIX_TOKEN: process.env.KORTIX_TOKEN,
    KORTIX_API_URL: process.env.KORTIX_API_URL,
  }
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
function sessionEnv(apiUrl: string) {
  process.env.KORTIX_PROJECT_ID = 'p1'
  process.env.KORTIX_SESSION_ID = 's1'
  process.env.KORTIX_TOKEN = 't1'
  process.env.KORTIX_API_URL = apiUrl
}

describe('reconcileFinishedTrackedTurns — every tracked root, on reconnect and on the tick', () => {
  test('begin relayed for S (not the pinned root) → OpenCode restarts → S idle+completed → exactly ONE synthetic end for S', async () => {
    const api = startMockApi()
    sessionEnv(api.url)
    const state: MockOpencodeState = { busy: new Set([S]), completedAt: new Map(), userMessageId: new Map() }
    const ocA = startMockOpencode(state)
    let current = ocA.url
    const opencode = { getInternalUrl: () => current } as unknown as Opencode
    const cfg = { workspace: WORKSPACE } as unknown as Config
    const loop = startOpencodeEventLoop(opencode, cfg, {
      onSessionIdle: (id) => void relayTurnEndToApi(id, 'idle', opencode, cfg),
      onConnected: () => void reconcileFinishedTrackedTurns(opencode, cfg),
    })
    let ocB: ReturnType<typeof startMockOpencode> | null = null
    try {
      await loop.connected
      // A `busy` frame for S → the begin relay tracks S as a root a turn ran on.
      await relayTurnBeginToApi(S, opencode, cfg)
      expect(api.begins.length).toBe(1)
      expect(trackedRootTurnSessions()).toEqual([S])

      // The verified swap: the new process is promoted, the old one is killed.
      // S's turn finishes on the NEW process while the loop is between
      // subscriptions — its session.idle is emitted to nobody.
      state.busy.delete(S)
      state.completedAt.set(S, 1_700_000_000_000)
      ocB = startMockOpencode(state)
      current = ocB.url
      ocA.stop()

      // The loop reconnects to B (~100ms) and onConnected reconciles S.
      const deadline = Date.now() + 3_000
      while (api.ends.length === 0 && Date.now() < deadline) await sleep(25)
      await sleep(150)
      expect(ocB.subscribes()).toBeGreaterThanOrEqual(1)
      expect(api.ends.length).toBe(1)
      expect(api.ends[0]).toMatchObject({
        kind: 'end',
        status: 'idle',
        opencode_session_id: S,
        turn_message_id: `msg_user_${S}`,
      })

      // Idempotent: a second reconnect / tick relays nothing new.
      await reconcileFinishedTrackedTurns(opencode, cfg)
      await reconcileFinishedTrackedTurns(opencode, cfg)
      expect(api.ends.length).toBe(1)
    } finally {
      loop.stop()
      ocA.stop()
      ocB?.stop()
      api.stop()
    }
  })

  test('a tracked root that is still BUSY relays nothing; once idle it relays once', async () => {
    const api = startMockApi()
    sessionEnv(api.url)
    const state: MockOpencodeState = {
      busy: new Set([S]),
      completedAt: new Map([[S, 1_700_000_000_111]]), // a PREVIOUS turn's reply; S runs another
      userMessageId: new Map(),
    }
    const oc = startMockOpencode(state)
    const opencode = { getInternalUrl: () => oc.url } as unknown as Opencode
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      trackRootTurnSession(S, 'proxied_prompt')
      await reconcileFinishedTrackedTurns(opencode, cfg)
      expect(api.ends.length).toBe(0)
      state.busy.delete(S)
      await reconcileFinishedTrackedTurns(opencode, cfg)
      await reconcileFinishedTrackedTurns(opencode, cfg)
      expect(api.ends.length).toBe(1)
    } finally {
      oc.stop()
      api.stop()
    }
  })

  test('a tracked root with NO completed reply relays nothing (a turn that has not answered is not over)', async () => {
    const api = startMockApi()
    sessionEnv(api.url)
    const state: MockOpencodeState = { busy: new Set(), completedAt: new Map([[S, null]]), userMessageId: new Map() }
    const oc = startMockOpencode(state)
    const opencode = { getInternalUrl: () => oc.url } as unknown as Opencode
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      trackRootTurnSession(S, 'proxied_prompt')
      await reconcileFinishedTrackedTurns(opencode, cfg)
      expect(api.ends.length).toBe(0)
    } finally {
      oc.stop()
      api.stop()
    }
  })

  test('OpenCode unreachable → nothing relayed, nothing thrown', async () => {
    const api = startMockApi()
    sessionEnv(api.url)
    const opencode = { getInternalUrl: () => 'http://127.0.0.1:9' } as unknown as Opencode
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      trackRootTurnSession(S, 'proxied_prompt')
      await reconcileFinishedTrackedTurns(opencode, cfg)
      expect(api.ends.length).toBe(0)
    } finally {
      api.stop()
    }
  })

  test('the initial-turn (pinned root) reconcile is unchanged and runs beside the tracked one', async () => {
    const api = startMockApi()
    sessionEnv(api.url)
    const state: MockOpencodeState = {
      busy: new Set(),
      completedAt: new Map([
        [PINNED, 1_700_000_000_222],
        [S, 1_700_000_000_333],
      ]),
      userMessageId: new Map(),
    }
    const oc = startMockOpencode(state)
    const opencode = { getInternalUrl: () => oc.url } as unknown as Opencode
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      trackRootTurnSession(S, 'proxied_prompt')
      await Promise.all([
        reconcileFinishedFirstTurn(opencode, cfg, PINNED),
        reconcileFinishedTrackedTurns(opencode, cfg),
      ])
      const bySession = api.ends.map((e) => e.opencode_session_id).sort()
      expect(bySession).toEqual([PINNED, S].sort())
      // Second pass: both deduped.
      await reconcileFinishedFirstTurn(opencode, cfg, PINNED)
      await reconcileFinishedTrackedTurns(opencode, cfg)
      expect(api.ends.length).toBe(2)
    } finally {
      oc.stop()
      api.stop()
    }
  })
})
