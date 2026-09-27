import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startOpencodeEventLoop } from '../harness/open-code/events'
import {
  __resetRelayedTurnSignatures,
  reconcileFinishedFirstTurn,
  relayTurnEndToApi,
} from '../harness/open-code/boot'
import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import type { Opencode } from '../harness/open-code/lifecycle'
import { writeOpenCodeSessionPin } from '../harness/open-code/runtime-state'

// The COLD-first-turn event-loss race, driven through the REAL daemon
// primitives (startOpencodeEventLoop + dispatch + relayTurnEndToApi +
// reconcileFinishedFirstTurn) against a mock opencode with the two behaviors
// that create it:
//   (1) /event is a live SSE stream with NO REPLAY — a session.idle emitted
//       before any subscriber connects is gone (OpenCode's behavior).
//   (2) A trivial first turn reaches session.idle a few ms after the prompt.
// Boot subscribes before it delivers the prompt (boot-source-guards.test.ts);
// the reconcile-on-connect below is the backstop for a residual gap.

const ROOT = 'ses_root'
const WORKSPACE = '/workspace'

// Faithful mock opencode. Tracks subscribers to /event; a session.idle emitted
// while there are ZERO subscribers is dropped (no replay) — the crux of the race.
function startMockOpencode() {
  let subscribers = 0
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let turnCompletedAt: number | null = null
  const enc = new TextEncoder()

  function emitIdle() {
    const frame = `data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: ROOT } })}\n\n`
    // Delivered ONLY to currently-connected subscribers. No buffering, no replay:
    // if subscribers === 0 the event is gone forever (opencode's real behavior).
    for (const c of streams) c.enqueue(enc.encode(frame))
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      // Live SSE /event stream.
      if (url.pathname === '/event') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            subscribers++
            streams.add(controller)
            // Emit an initial SSE keepalive comment so the client's fetch()
            // resolves immediately (real opencode streams data on connect; Bun's
            // fetch otherwise blocks until the first byte). The subscription is
            // "live" the instant this lands.
            controller.enqueue(enc.encode(':ok\n\n'))
          },
          cancel() {
            subscribers--
          },
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      // Fire the first turn: after a SHORT delay (trivial turn on a fast boot),
      // mark it completed and emit session.idle to whoever is subscribed NOW.
      if (url.pathname === `/session/${ROOT}/prompt_async`) {
        setTimeout(() => {
          turnCompletedAt = Date.now()
          emitIdle()
        }, 30) // trivial turn finishes ~30ms after prompt
        return Response.json({ ok: true })
      }
      // Root session lookup (no parentID → is-root check passes).
      if (url.pathname === `/session/${ROOT}`) {
        return Response.json({ parentID: null })
      }
      // Message list — last assistant message carries the completed timestamp
      // (the turn's identity / dedup key), once the turn has finished.
      if (url.pathname === `/session/${ROOT}/message`) {
        return Response.json([
          { info: { role: 'user' } },
          { info: { role: 'assistant', time: { completed: turnCompletedAt ?? undefined } } },
        ])
      }
      return new Response('nf', { status: 404 })
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    subscribers: () => subscribers,
    emitIdle,
    firePrompt: () => fetch(`http://127.0.0.1:${server.port}/session/${ROOT}/prompt_async`, { method: 'POST' }),
    stop: () => server.stop(true),
  }
}

// Mock apps/api counting turn-end relays (the Slack finalize).
function startMockApi() {
  let ends = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith('/turn-stream')) {
        const body = (await req.json().catch(() => ({}))) as { kind?: string }
        if (body.kind === 'end') ends++
        return Response.json({ ok: true })
      }
      return new Response('nf', { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, ends: () => ends, stop: () => server.stop(true) }
}

function fakeOpencode(baseUrl: string): Opencode {
  return { getInternalUrl: () => baseUrl } as unknown as Opencode
}
function fakeCfg(baseUrl: string): Config {
  return { workspace: WORKSPACE, opencodeInternalPort: Number(new URL(baseUrl).port) } as unknown as Config
}

let saved: Record<string, string | undefined> = {}
let stateDir: string
beforeEach(() => {
  __resetRelayedTurnSignatures()
  saved = {
    SLACK_CHANNEL_ID: process.env.SLACK_CHANNEL_ID,
    KORTIX_PROJECT_ID: process.env.KORTIX_PROJECT_ID,
    KORTIX_SESSION_ID: process.env.KORTIX_SESSION_ID,
    KORTIX_TOKEN: process.env.KORTIX_TOKEN,
    KORTIX_API_URL: process.env.KORTIX_API_URL,
    KORTIX_RUNTIME_STATE_DIR: process.env.KORTIX_RUNTIME_STATE_DIR,
  }
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-cold-first-turn-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(stateDir, { recursive: true, force: true })
})
function slackEnv(apiUrl: string) {
  process.env.SLACK_CHANNEL_ID = 'C1'
  process.env.KORTIX_PROJECT_ID = 'p1'
  process.env.KORTIX_SESSION_ID = 's1'
  process.env.KORTIX_TOKEN = 't1'
  process.env.KORTIX_API_URL = apiUrl
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('reconcile-on-connect', () => {
  test('a first turn that completed before the subscribe finalizes exactly once, even when its idle arrives late', async () => {
    const oc = startMockOpencode()
    const api = startMockApi()
    slackEnv(api.url)
    writeOpenCodeSessionPin(ROOT)
    const opencode = fakeOpencode(oc.baseUrl)
    const cfg = fakeCfg(oc.baseUrl)
    const onSessionIdle = (id: string) => void relayTurnEndToApi(id, 'idle', opencode, cfg)
    try {
      // The turn completes before any subscriber: its live idle is lost.
      await oc.firePrompt()
      await sleep(60)
      expect(api.ends()).toBe(0)

      // Production wiring: onConnected reconciles the pinned root's finished turn.
      const loop = startOpencodeEventLoop(opencode, cfg, {
        onSessionIdle,
        onConnected: () => void reconcileFinishedFirstTurn(opencode, cfg),
      })
      await loop.connected
      await sleep(200)
      expect(api.ends()).toBe(1)

      // A late natural idle for the same turn is collapsed by the per-turn dedup.
      oc.emitIdle()
      await sleep(200)
      loop.stop()
      expect(api.ends()).toBe(1)
    } finally {
      loopCleanup(oc, api)
    }
  })
})

function loopCleanup(oc: { stop: () => void }, api: { stop: () => void }) {
  try { oc.stop() } catch {}
  try { api.stop() } catch {}
}
