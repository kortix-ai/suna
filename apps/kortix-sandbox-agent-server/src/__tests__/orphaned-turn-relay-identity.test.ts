/**
 * Regression for the 2026-09-29 incident's second defect: after a respawn
 * (an env-driven restart, an agent swap, a crash), `finalizeOrphanedTurn`
 * aborts the orphaned turn on whichever process now answers for the root —
 * a process that never held that turn's generation, so it stamps neither
 * `time.completed` nor an error on the message. `relayTurnEndToApi` and
 * `reconcileFinishedFirstTurn` (boot.ts) both scan for the newest COMPLETED
 * assistant message; after this abort that scan keeps finding the turn
 * BEFORE this one, already relayed, and skips FOREVER — a
 * `GET .../turn` API ledger row stuck `active` with `message_id: null`
 * for hours, cleared only by `kortix sessions stop`.
 *
 * Fix: `finalizeOrphanedTurn` relays the orphaned turn's own end directly
 * (`relayOrphanedTurnEndToApi`), keyed by its own prompt id — never by the
 * previous turn's `completedAt`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finalizeOrphanedTurn, relayTurnEndToApi, __resetRelayedTurnSignatures } from '@/harness/open-code/boot'
import type { OpenCodeConfig as Config } from '@/harness/open-code/config'
import { resetSessionTokenHealthForTests } from '@/lib/kortix-api/session-token-health'

const ROOT = 'ses_root'
const WORKSPACE = '/workspace'

/**
 * One mock covering BOTH endpoints `finalizeOrphanedTurn` touches: OpenCode's
 * message list + abort (mutable `transcript`, `abort` is a no-op — exactly
 * the incident's bug: a respawned process never held this turn's generation,
 * so `/abort` changes nothing on disk), and apps/api's turn-stream relay
 * target (records every body it receives).
 */
function startMocks(transcript: () => unknown[]) {
  let turnStreamCalls = 0
  const turnStreamBodies: Array<Record<string, unknown>> = []
  let abortCalls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/turn-stream')) {
        turnStreamCalls++
        turnStreamBodies.push((await req.json()) as Record<string, unknown>)
        return Response.json({ ok: true })
      }
      if (url.pathname.endsWith('/abort')) {
        abortCalls++
        return new Response('{}', { status: 200 }) // no-op: nothing on disk changes
      }
      if (url.pathname === `/session/${ROOT}/message`) {
        return Response.json(transcript())
      }
      // relayTurnEndToApi's root classification (classifyOpencodeSession):
      // a root session has no parentID. Needed only by the `relayTurnEndToApi`
      // sanity/negative-control calls below — finalizeOrphanedTurn itself
      // never asks this.
      if (url.pathname === `/session/${ROOT}`) {
        return Response.json({ parentID: null })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    turnStreamCalls: () => turnStreamCalls,
    turnStreamBodies: () => turnStreamBodies,
    abortCalls: () => abortCalls,
    stop: () => server.stop(true),
  }
}

let saved: Record<string, string | undefined> = {}
let stateDir: string
let priorStateDir: string | undefined
beforeEach(() => {
  __resetRelayedTurnSignatures()
  resetSessionTokenHealthForTests()
  priorStateDir = process.env.KORTIX_RUNTIME_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-orphan-relay-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
  saved = {
    KORTIX_PROJECT_ID: process.env.KORTIX_PROJECT_ID,
    KORTIX_SESSION_ID: process.env.KORTIX_SESSION_ID,
    KORTIX_TOKEN: process.env.KORTIX_TOKEN,
    KORTIX_API_URL: process.env.KORTIX_API_URL,
  }
})
afterEach(() => {
  resetSessionTokenHealthForTests()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  if (priorStateDir === undefined) delete process.env.KORTIX_RUNTIME_STATE_DIR
  else process.env.KORTIX_RUNTIME_STATE_DIR = priorStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

function sessionEnv(apiUrl: string) {
  process.env.KORTIX_PROJECT_ID = 'proj_1'
  process.env.KORTIX_SESSION_ID = 'sess_1'
  process.env.KORTIX_TOKEN = 'tok'
  process.env.KORTIX_API_URL = apiUrl
}

describe('finalizeOrphanedTurn relays the orphaned turn by its OWN identity', () => {
  test('relays the orphan even though the PREVIOUS turn is already relayed and its signature is recorded', async () => {
    // Turn 1 (msg_turn_1) already completed and was already relayed — the
    // exact state a real box is in seconds after a restart, per the incident
    // log's "reconciling turn that completed before subscribe … already
    // relayed; skipping" loop.
    const turn1 = [
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: { completed: 1000 } } },
    ]
    const m = startMocks(() => turn1)
    sessionEnv(m.baseUrl)
    const cfg = { workspace: WORKSPACE } as unknown as Config
    try {
      // Record turn 1's dedup signature exactly as the natural relay would.
      await relayTurnEndToApi(ROOT, 'idle', { getInternalUrl: () => m.baseUrl }, cfg)
      expect(m.turnStreamCalls()).toBe(1)

      // A daemon restart orphans a SECOND turn (msg_turn_2): its assistant
      // reply is incomplete and the abort that follows is a no-op — the
      // process now answering for this root never held the generation.
      const withOrphan = [
        ...turn1,
        { info: { id: 'msg_turn_2', role: 'user' } },
        { info: { role: 'assistant', parentID: 'msg_turn_2', time: {} } },
      ]
      m.stop()
      const m2 = startMocks(() => withOrphan)
      sessionEnv(m2.baseUrl)
      try {
        // Sanity check: the OLD relay path finds nothing new — this is the
        // bug being fixed, kept as the negative control.
        await relayTurnEndToApi(ROOT, 'idle', { getInternalUrl: () => m2.baseUrl }, cfg)
        expect(m2.turnStreamCalls()).toBe(0) // still sees only turn 1 -> already relayed, skips

        const finalized = await finalizeOrphanedTurn(m2.baseUrl, WORKSPACE, ROOT)

        expect(finalized).toBe(true)
        expect(m2.abortCalls()).toBe(1)
        // THE FIX: the orphaned turn relays its OWN end, keyed by msg_turn_2.
        expect(m2.turnStreamCalls()).toBe(1)
        const body = m2.turnStreamBodies()[0]
        expect(body?.kind).toBe('end')
        expect(body?.runtime_session_id).toBe(ROOT)
        expect(body?.turn_message_id).toBe('msg_turn_2')
        expect(body?.status).toBe('error')
      } finally {
        m2.stop()
      }
    } finally {
      m.stop()
    }
  }, 15_000)

  test('relays the orphan at most once across repeated finalize calls (unplanned-respawn hook + reused-root boot check both call it)', async () => {
    const withOrphan = [
      { info: { id: 'msg_turn_1', role: 'user' } },
      { info: { role: 'assistant', parentID: 'msg_turn_1', time: {} } },
    ]
    const m = startMocks(() => withOrphan)
    sessionEnv(m.baseUrl)
    try {
      const first = await finalizeOrphanedTurn(m.baseUrl, WORKSPACE, ROOT)
      const second = await finalizeOrphanedTurn(m.baseUrl, WORKSPACE, ROOT)

      expect(first).toBe(true)
      expect(second).toBe(true) // the abort is a no-op, so the turn still reads orphaned
      expect(m.abortCalls()).toBe(2)
      // But the API relay is deduped by the turn's own identity.
      expect(m.turnStreamCalls()).toBe(1)
    } finally {
      m.stop()
    }
  }, 15_000)

  test('does not relay when the orphaned assistant carries no parentID (nothing to key on)', async () => {
    const withOrphan = [{ info: { id: 'msg_turn_1', role: 'assistant', time: {} } }]
    const m = startMocks(() => withOrphan)
    sessionEnv(m.baseUrl)
    try {
      const finalized = await finalizeOrphanedTurn(m.baseUrl, WORKSPACE, ROOT)
      expect(finalized).toBe(true)
      expect(m.abortCalls()).toBe(1)
      expect(m.turnStreamCalls()).toBe(0)
    } finally {
      m.stop()
    }
  }, 15_000)
})
