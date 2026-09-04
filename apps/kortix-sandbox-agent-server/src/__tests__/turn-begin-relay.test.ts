import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { relayTurnBeginToApi, __resetRelayedTurnBegins } from '../main'
import { dispatch } from '../opencode-events'
import type { Config } from '../config'

// A BOX-INITIATED turn (OpenCode's synthetic `<pty_exited>` wake-up) must be
// announced to apps/api so it gets turn authority — live incident 2026-08-20
// (Essentia session d1b74954): pty-driven turns streamed for 10+ minutes while
// `GET .../turn` reported idle, because nothing ever told the control plane a
// turn had started.

const ROOT = 'ses_root'
const CHILD = 'ses_child'
const WORKSPACE = '/workspace'

function startMocks(getMessages: () => unknown[]) {
  let turnStreamCalls = 0
  const turnStreamBodies: Array<Record<string, unknown>> = []
  const turnStreamAuth: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/turn-stream')) {
        turnStreamCalls++
        turnStreamAuth.push(req.headers.get('authorization'))
        turnStreamBodies.push((await req.json()) as Record<string, unknown>)
        return Response.json({ ok: true, outcome: 'adopted' })
      }
      if (url.pathname === `/session/${ROOT}/message`) {
        return Response.json(getMessages())
      }
      if (url.pathname === `/session/${ROOT}`) {
        return Response.json({ parentID: null })
      }
      if (url.pathname === `/session/${CHILD}`) {
        return Response.json({ parentID: ROOT })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls: () => turnStreamCalls,
    bodies: () => turnStreamBodies,
    auth: () => turnStreamAuth,
    stop: () => server.stop(true),
  }
}

let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  __resetRelayedTurnBegins()
  saved = {
    KORTIX_PROJECT_ID: process.env.KORTIX_PROJECT_ID,
    KORTIX_SESSION_ID: process.env.KORTIX_SESSION_ID,
    KORTIX_TOKEN: process.env.KORTIX_TOKEN,
    KORTIX_API_URL: process.env.KORTIX_API_URL,
  }
  delete process.env.KORTIX_TOKEN
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function sessionEnv(apiUrl: string) {
  process.env.KORTIX_PROJECT_ID = 'proj_1'
  process.env.KORTIX_SESSION_ID = 'sess_1'
  process.env.KORTIX_TOKEN = 'tok'
  process.env.KORTIX_API_URL = apiUrl
}

const syntheticTurn = () => [
  { info: { id: 'msg_user_1', role: 'user' } },
  { info: { id: 'msg_asst_1', role: 'assistant', parentID: 'msg_user_1', time: { completed: 1 } } },
  { info: { id: 'msg_pty_2', role: 'user' } },
]

describe('relayTurnBeginToApi — box-initiated turn adoption', () => {
  test('relays turn_begin naming the NEWEST user message', async () => {
    const m = startMocks(syntheticTurn)
    sessionEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      expect(m.calls()).toBe(1)
      expect(m.bodies()[0]).toMatchObject({
        kind: 'turn_begin',
        opencode_session_id: ROOT,
        turn_message_id: 'msg_pty_2',
      })
    } finally {
      m.stop()
    }
  })

  test('one turn relays once no matter how many status frames fire', async () => {
    const m = startMocks(syntheticTurn)
    sessionEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      expect(m.calls()).toBe(1)
    } finally {
      m.stop()
    }
  })

  test('a NEW user message relays again', async () => {
    let messages = syntheticTurn()
    const m = startMocks(() => messages)
    sessionEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      messages = [...syntheticTurn(), { info: { id: 'msg_pty_3', role: 'user' } }]
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      expect(m.calls()).toBe(2)
      expect(m.bodies()[1]?.turn_message_id).toBe('msg_pty_3')
    } finally {
      m.stop()
    }
  })

  test('a CHILD session never relays — only root turns carry authority', async () => {
    const m = startMocks(syntheticTurn)
    sessionEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(CHILD, opencode, cfg)
      expect(m.calls()).toBe(0)
    } finally {
      m.stop()
    }
  })

  test('no user message on the root relays nothing', async () => {
    const m = startMocks(() => [])
    sessionEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      expect(m.calls()).toBe(0)
    } finally {
      m.stop()
    }
  })

  test('authenticates with the single session credential', async () => {
    const m = startMocks(syntheticTurn)
    sessionEnv(m.baseUrl)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      expect(m.calls()).toBe(1)
      expect(m.auth()[0]).toBe('Bearer tok')
    } finally {
      m.stop()
    }
  })

  test('does not relay without the session credential', async () => {
    const m = startMocks(syntheticTurn)
    sessionEnv(m.baseUrl)
    delete process.env.KORTIX_TOKEN
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      expect(m.calls()).toBe(0)
    } finally {
      m.stop()
    }
  })

  test('does not relay without sandbox callback identity', async () => {
    const m = startMocks(syntheticTurn)
    const opencode = { getInternalUrl: () => m.baseUrl }
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      await relayTurnBeginToApi(ROOT, opencode, cfg)
      expect(m.calls()).toBe(0)
    } finally {
      m.stop()
    }
  })
})

// The wiring itself, pinned separately from the relay's behavior: the live
// event loop routes every frame through `dispatch`, so a `session.status`
// frame must reach `onSessionStatus`. Verified against a REAL frame captured
// from opencode 1.18.19 on dev (`{"sessionID":"ses_…","status":{"type":"busy"}}`).
describe('dispatch → onSessionStatus', () => {
  test('a real busy frame reaches the handler', () => {
    const seen: Array<[string, string]> = []
    dispatch(
      { type: 'session.status', properties: { sessionID: 'ses_root', status: { type: 'busy' } } },
      { onSessionStatus: (s, t) => seen.push([s, t]) },
    )
    expect(seen).toEqual([['ses_root', 'busy']])
  })

  test('session.idle is not swallowed by the status branch', () => {
    let idle = ''
    dispatch(
      { type: 'session.idle', properties: { sessionID: 'ses_root' } },
      { onSessionStatus: () => {}, onSessionIdle: (s) => { idle = s } },
    )
    expect(idle).toBe('ses_root')
  })
})
