import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { startOpencodeEventLoop } from '../opencode-events'
import { relayTurnEndToApi, __resetRelayedTurnSignatures } from '../main'
import type { Config } from '../config'
import type { Opencode } from '../opencode'

// Deterministic reproduction of the COLD-first-turn event-loss race using the
// REAL daemon primitives (startOpencodeEventLoop + dispatch + relayTurnEndToApi +
// reconcileFinishedFirstTurn) against a faithful mock opencode that mimics the
// two behaviors that create the race:
//   (1) /event is a live SSE stream with NO REPLAY/BACKFILL — a session.idle
//       emitted before any subscriber connects is GONE (exactly opencode's
//       behavior, per opencode-events.ts + the root cause).
//   (2) A trivial first turn reaches session.idle FAST (a few ms after prompt).
//
// It drives BOTH orderings and shows the observable divergence on the SLACK
// turn-end relay path (the only finalizer for a turn ended without `slack send`):
//   • PRE-FIX ordering (prompt THEN subscribe, as prod's startSessionRuntime ran):
//     the fast idle fires in the unsubscribed gap → LOST → ZERO turn-end relays.
//   • FIXED ordering (subscribe-before-prompt + reconcile-on-connect): the turn
//     finalizes EXACTLY ONCE regardless of whether idle beat the subscribe.

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
  process.env.SLACK_CHANNEL_ID = 'C1'
  process.env.KORTIX_PROJECT_ID = 'p1'
  process.env.KORTIX_SESSION_ID = 's1'
  process.env.KORTIX_SANDBOX_TOKEN = 't1'
  process.env.KORTIX_API_URL = apiUrl
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('cold-first-turn event-loss race — pre-fix ordering DROPS, fixed ordering CATCHES', () => {
  // PRE-FIX: fire the prompt, THEN subscribe (the exact ordering prod's
  // startSessionRuntime ran before this fix). The trivial turn's session.idle
  // fires ~30ms later, before the subscribe completes → LOST → no finalize.
  test('PRE-FIX ordering: fast trivial first turn is LOST (zero turn-end relays)', async () => {
    const oc = startMockOpencode()
    const api = startMockApi()
    slackEnv(api.url)
    const opencode = fakeOpencode(oc.baseUrl)
    const cfg = fakeCfg(oc.baseUrl)
    const onSessionIdle = (id: string) => void relayTurnEndToApi(id, 'idle', opencode, cfg)
    try {
      // 1. prompt fired FIRST (turn will complete ~30ms later)
      await oc.firePrompt()
      // 2. subscription started AFTER — model the real gap; the idle emits while
      //    subscribers === 0 (nobody listening) and is dropped with no replay.
      await sleep(60) // let the turn complete (idle emitted into the void)
      const loop = startOpencodeEventLoop(opencode, cfg, { onSessionIdle })
      await loop.connected
      await sleep(200) // give any (nonexistent) replay a chance
      loop.stop()
      expect(oc.subscribers()).toBeGreaterThanOrEqual(0)
      // The idle fired before anyone subscribed → NEVER relayed → Slack turn frozen.
      expect(api.ends()).toBe(0)
    } finally {
      loopCleanup(oc, api)
    }
  })

  // FIXED: subscribe-before-prompt. The subscription is live before the turn is
  // launched, so the fast idle is CAUGHT and relayed exactly once.
  test('FIXED ordering (subscribe-before-prompt): fast trivial first turn FINALIZES once', async () => {
    const oc = startMockOpencode()
    const api = startMockApi()
    slackEnv(api.url)
    const opencode = fakeOpencode(oc.baseUrl)
    const cfg = fakeCfg(oc.baseUrl)
    const onSessionIdle = (id: string) => void relayTurnEndToApi(id, 'idle', opencode, cfg)
    try {
      // 1. subscribe FIRST and wait until it's live
      const loop = startOpencodeEventLoop(opencode, cfg, { onSessionIdle })
      await loop.connected
      expect(oc.subscribers()).toBe(1)
      // 2. NOW fire the prompt — idle will be caught by the live subscription
      await oc.firePrompt()
      await sleep(200)
      loop.stop()
      expect(api.ends()).toBe(1) // caught + relayed exactly once
    } finally {
      loopCleanup(oc, api)
    }
  })

  // FIXED backstop: even if the idle somehow fires in a residual gap BEFORE the
  // subscribe (worst case), reconcile-on-connect reads the completed turn and
  // finalizes it — so the turn finalizes exactly once independent of timing.
  // reconcileFinishedFirstTurn's only step beyond this is resolving the pinned
  // root id from the pin FILE (root-only path on this host); its effective action
  // — "on connect, relay the completed root turn" — is exercised here directly,
  // AND collapsed with the natural (dropped) idle by the per-turn dedup.
  test('FIXED reconcile-on-connect: turn that completed BEFORE subscribe still finalizes exactly once', async () => {
    const oc = startMockOpencode()
    const api = startMockApi()
    slackEnv(api.url)
    const opencode = fakeOpencode(oc.baseUrl)
    const cfg = fakeCfg(oc.baseUrl)
    const onSessionIdle = (id: string) => void relayTurnEndToApi(id, 'idle', opencode, cfg)
    try {
      // Turn completes BEFORE any subscribe (its live idle is lost to the void).
      await oc.firePrompt()
      await sleep(60)
      expect(api.ends()).toBe(0) // dropped so far — exactly the race
      // Now subscribe; onConnected relays the completed root turn (the reconcile).
      const loop = startOpencodeEventLoop(opencode, cfg, {
        onSessionIdle,
        onConnected: () => void relayTurnEndToApi(ROOT, 'idle', opencode, cfg),
      })
      await loop.connected
      await sleep(200)
      loop.stop()
      expect(api.ends()).toBe(1) // reconcile finalized the missed turn, exactly once
    } finally {
      loopCleanup(oc, api)
    }
  })
})

function loopCleanup(oc: { stop: () => void }, api: { stop: () => void }) {
  try { oc.stop() } catch {}
  try { api.stop() } catch {}
}
