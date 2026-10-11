/**
 * A box with no local pin file resumes the root the control plane pinned.
 *
 * Prod 2026-09-23: a converged legacy box booted without
 * `opencode-session-id`, adopted (or created) a different root, and the relay
 * wrote it over the durable pin. The session opened blank. #8322 resolved the
 * boot root from `localPin ?? claimedRuntimeSessionPin()`; #8600 dropped the
 * fallback in a code move. These tests drive `maybeCreateInitialOpencodeSession`
 * over a fake OpenCode and a fake API so the fallback cannot vanish again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { maybeCreateInitialOpencodeSession } from '@/harness/open-code/initial-session'
import type { Opencode } from '@/harness/open-code/lifecycle'
import type { OpenCodeBootState } from '@/harness/open-code/boot-state'
import { resetInitialTurnClaimForTests } from '@/harness/shared/turn-relay'

const KEYS = [
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_RUNTIME_STATE_DIR',
  'KORTIX_BOOTSTRAP_OPENCODE_SESSION',
  'KORTIX_WORKSPACE',
] as const

let saved: Record<string, string | undefined> = {}
let stateDir = ''
const servers: Array<{ stop(closeActive?: boolean): void }> = []

beforeEach(() => {
  resetInitialTurnClaimForTests()
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  stateDir = mkdtempSync(join(tmpdir(), 'kortixd-claimed-pin-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
  process.env.KORTIX_BOOTSTRAP_OPENCODE_SESSION = '1'
  process.env.KORTIX_WORKSPACE = '/workspace'
  process.env.KORTIX_PROJECT_ID = 'project-1'
  process.env.KORTIX_SESSION_ID = 'session-1'
  process.env.KORTIX_TOKEN = 'session-token'
})

afterEach(() => {
  resetInitialTurnClaimForTests()
  for (const s of servers.splice(0)) s.stop(true)
  rmSync(stateDir, { recursive: true, force: true })
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Boots the root path against an OpenCode holding the conversation root and a
 *  NEWER empty root (the incident shape), with the API pinning the older one. */
async function bootWithClaimedPin() {
  const relayed: string[] = []
  const created: string[] = []
  const { promise: relayArrived, resolve: onRelay } = Promise.withResolvers<void>()
  const api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as { kind?: string; runtime_session_id?: string }
      if (body.kind === 'initial_turn_claim') {
        return Response.json({ ok: true, initial_turn: null, runtime_session_id: 'ses_conversation' })
      }
      if (body.kind === 'runtime_session' && body.runtime_session_id) {
        relayed.push(body.runtime_session_id)
        onRelay()
      }
      return Response.json({ ok: true })
    },
  })
  const opencodeServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/session') {
        return Response.json([
          { id: 'ses_conversation', time: { created: 1, updated: 2 } },
          { id: 'ses_empty_newer', time: { created: 10, updated: 10 } },
        ])
      }
      if (request.method === 'GET' && url.pathname.endsWith('/message')) return Response.json([])
      if (request.method === 'POST' && url.pathname === '/session') {
        created.push('ses_created')
        return Response.json({ id: 'ses_created' })
      }
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(api, opencodeServer)
  process.env.KORTIX_API_URL = `http://127.0.0.1:${api.port}/v1`

  const opencode = {
    waitForCurrentListening: () => Promise.resolve(),
    getInternalUrl: () => `http://127.0.0.1:${opencodeServer.port}`,
  } as unknown as Opencode
  const bootState = { timeline: [] } as unknown as OpenCodeBootState
  await maybeCreateInitialOpencodeSession(opencode, bootState, () => {})
  // relayRuntimeSession is fire-and-forget: wait for it to reach the fake API.
  await Promise.race([
    relayArrived,
    Bun.sleep(2_000).then(() => {
      throw new Error('runtime_session relay did not arrive within 2 s')
    }),
  ])
  return { bootState, relayed, created }
}

describe('maybeCreateInitialOpencodeSession — the control plane pin is the fallback', () => {
  test('with the pin file deleted, boot resumes the claimed root, not the newest', async () => {
    const { bootState, relayed, created } = await bootWithClaimedPin()

    expect(bootState.initialRuntimeSessionId).toBe('ses_conversation')
    expect(readFileSync(join(stateDir, 'opencode-session-id'), 'utf8')).toBe('ses_conversation')
    expect(relayed).toEqual(['ses_conversation'])
    expect(created).toEqual([])
  })

  test('a local pin still wins over the claimed pin', async () => {
    writeFileSync(join(stateDir, 'opencode-session-id'), 'ses_empty_newer')
    const { bootState, relayed } = await bootWithClaimedPin()

    expect(bootState.initialRuntimeSessionId).toBe('ses_empty_newer')
    expect(relayed).toEqual(['ses_empty_newer'])
  })
})
