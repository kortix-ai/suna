/**
 * A self-heal restart must NOT cause the failed prompt to be redelivered.
 *
 * THE BUG THIS PINS
 * `ModelNotFound` kills a turn ~2ms after the prompt, before OpenCode has
 * created any assistant message. The root's last message is therefore the user
 * prompt, unanswered — which is byte-for-byte what a DROPPED delivery looks
 * like. The control plane acts on that: the reaper reads `/kortix/health?turn=1`,
 * sees `turn_orphaned_prompt`, and re-POSTs the prompt from the inbox with a
 * freshly minted wire id (apps/api box-reaper.ts `redeliverAbandonedPrompt`).
 * Observed on a real box: the transcript ended with two user messages of
 * identical text, the second carrying the error.
 *
 * What lets the reaper reach that branch is the turn record surviving as
 * `active`. TWO independent things caused that, and both are fixed here:
 *
 *  1. ORDERING. `relayTurnEndToApi` reads OpenCode twice before it posts — the
 *     root's message list and the session's `parentID` — and both fail closed
 *     (`isRootOpencodeSession` answers `false` on any error, and the relay then
 *     returns without posting). A restart racing the relay does not delay the
 *     turn end, it DELETES it. So the relay is now posted and ACKED before
 *     `opencode.restart()` may run.
 *
 *  2. IDENTITY. apps/api's `completeSandboxTurn` clears a turn record BY
 *     `messageId`; its fallback only matches records that carry none, and a
 *     prompt delivery always records one. A relay with no `turn_message_id`
 *     therefore matches nothing — the route still answers 200, so the daemon
 *     believes the turn closed while the record lives on. A turn that failed
 *     before its first token has no assistant message, so `parentID` (the usual
 *     source) does not exist; the failing PROMPT's own id is now sent instead.
 *
 * With both, a terminal error end (`isTerminalTurnEnd`: `isRetryable` unset ⇒
 * terminal) clears the record and stamps `end_reason: 'failed'`, which is not
 * one of the never-ran reasons the redelivery path accepts. Nothing is left to
 * redeliver, and the user sees the error in place instead of a second bubble.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { handleSessionErrorEvent, relayTurnEndToApi, __resetRelayedTurnSignatures } from '../main'
import { loadConfig } from '../config'
import { resetManagedModelsStateForTests, type Opencode } from '../opencode'
import {
  registerModelReconcile,
  resetBootReconcileForTests,
  resetModelReconcileForTests,
} from '../model-reconcile'

const ROOT_SESSION = 'ses_root_1'
const PROMPT_MESSAGE = 'msg_01af50eaa'

/** Ordered log of the two things whose sequence is the whole point. */
let events: string[] = []
/** Every body POSTed to /turn-stream. */
let relayed: Record<string, unknown>[] = []
/** Flipped by `restart()`: after a restart the OLD OpenCode is gone, so any
 *  read the relay still needed would fail — exactly as on a real box. */
let opencodeDown = false

/** The in-guest OpenCode, for real, over loopback. */
const opencodeServer = Bun.serve({
  port: 0,
  fetch(req) {
    if (opencodeDown) return new Response('connection refused', { status: 502 })
    const url = new URL(req.url)
    // `readRootTurnState` — the failing turn produced NO assistant message, so
    // the last message on record is the user prompt. This is the shape that
    // reads as an orphaned prompt.
    if (url.pathname.endsWith('/message')) {
      return Response.json([{ info: { id: PROMPT_MESSAGE, role: 'user' } }])
    }
    // `isRootOpencodeSession` — no parentID ⇒ this is the root.
    if (url.pathname.startsWith('/session/')) return Response.json({ id: ROOT_SESSION })
    return new Response('not found', { status: 404 })
  },
})

/** apps/api's /v1/projects/:id/turn-stream. */
const apiServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, unknown>
    relayed.push(body)
    events.push(`relay:${String(body.kind)}:${String(body.status)}`)
    return Response.json({ ok: true })
  },
})

/** The LLM gateway the self-heal re-reads to learn the model really exists. */
const gatewayServer = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    const models =
      url.searchParams.get('scope') === 'managed'
        ? { 'grok-4.6': { name: 'Grok 4.6', provider: 'kortix' } }
        : { 'grok-4.6': { name: 'Grok 4.6', provider: 'kortix' } }
    return Response.json({ models })
  },
})

afterAll(() => {
  opencodeServer.stop(true)
  apiServer.stop(true)
  gatewayServer.stop(true)
})

const cfg = loadConfig({ KORTIX_WORKSPACE: '/workspace' } as NodeJS.ProcessEnv)
const tempDirs: string[] = []
const savedEnv = { ...process.env }

function fakeOpencode(restarts: { n: number }): Opencode {
  return {
    getInternalUrl: () => `http://127.0.0.1:${opencodeServer.port}`,
    getState: () => 'ok',
    markReady: () => {},
    restart: async () => {
      restarts.n++
      events.push('restart')
      // From here on the process the relay would have read is gone.
      opencodeDown = true
    },
  } as unknown as Opencode
}

async function tempCatalog(): Promise<{ current: string; target: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'kortix-selfheal-order-'))
  tempDirs.push(dir)
  const current = join(dir, 'baked.json')
  await writeFile(current, JSON.stringify({ models: { 'openai/gpt-5.5': { name: 'GPT-5.5' } } }))
  return { current, target: join(dir, 'session.json') }
}

beforeEach(() => {
  events = []
  relayed = []
  opencodeDown = false
  __resetRelayedTurnSignatures()
  resetManagedModelsStateForTests()
  resetBootReconcileForTests()
  resetModelReconcileForTests()
  process.env.KORTIX_PROJECT_ID = 'proj-1'
  process.env.KORTIX_SESSION_ID = 'sess-1'
  process.env.KORTIX_CLI_TOKEN = 'kortix_pat_test'
  process.env.KORTIX_API_URL = `http://127.0.0.1:${apiServer.port}/v1`
  process.env.KORTIX_LLM_BASE_URL = `http://127.0.0.1:${gatewayServer.port}`
  process.env.KORTIX_LLM_API_KEY = 'gw-key'
})

afterEach(async () => {
  resetManagedModelsStateForTests()
  resetBootReconcileForTests()
  resetModelReconcileForTests()
  for (const key of [
    'KORTIX_PROJECT_ID',
    'KORTIX_SESSION_ID',
    'KORTIX_CLI_TOKEN',
    'KORTIX_API_URL',
    'KORTIX_LLM_BASE_URL',
    'KORTIX_LLM_API_KEY',
    'KORTIX_LLM_CATALOG_FILE',
  ]) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('a ModelNotFound self-heal restart', () => {
  test('relays the turn end EXACTLY ONCE, and strictly before the restart', async () => {
    const { current, target } = await tempCatalog()
    process.env.KORTIX_LLM_CATALOG_FILE = current
    const restarts = { n: 0 }
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    await handleSessionErrorEvent(
      ROOT_SESSION,
      { name: 'UnknownError', message: 'ModelNotFound: kortix/grok-4.6' },
      fakeOpencode(restarts),
      cfg,
    )

    // ONE relay, and it landed before anything restarted OpenCode. If the two
    // were concurrent (the pre-fix shape), the restart could win, both OpenCode
    // reads inside the relay would fail, and NO relay would be posted at all.
    expect(events[0]).toBe('relay:end:error')
    expect(events).toContain('restart')
    expect(events.indexOf('relay:end:error')).toBeLessThan(events.indexOf('restart'))
    expect(relayed).toHaveLength(1)
    expect(restarts.n).toBe(1)
  }, 30_000)

  test('the relay marks the turn TERMINAL, which is what stops the redelivery', async () => {
    const { current, target } = await tempCatalog()
    process.env.KORTIX_LLM_CATALOG_FILE = current
    const restarts = { n: 0 }
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    await handleSessionErrorEvent(
      ROOT_SESSION,
      { name: 'UnknownError', message: 'ModelNotFound: kortix/grok-4.6' },
      fakeOpencode(restarts),
      cfg,
    )

    const body = relayed[0]!
    expect(body.kind).toBe('end')
    expect(body.status).toBe('error')
    expect(body.opencode_session_id).toBe(ROOT_SESSION)
    expect(body.error_name).toBe('UnknownError')
    expect(body.error_message).toBe('ModelNotFound: kortix/grok-4.6')
    // The API's `isTerminalTurnEnd` treats an error end as terminal unless
    // `isRetryable === true`. Sending it unset (or false) is what makes
    // `completeSandboxTurn` clear the active turn record — and a cleared record
    // is what the reaper's redelivery branch requires and will not find.
    expect(body.error_retryable).not.toBe(true)
    // THE OTHER HALF, and the one the ordering fix alone does not buy.
    // `completeSandboxTurn` clears a turn record BY `messageId`
    // (apps/api sandbox-turn-lifecycle.ts, `exact_matches`), and its fallback
    // only matches records that carry none — a prompt delivery always does. So
    // an end with no id matches nothing, the route still answers 200, and the
    // record survives for the reaper to redeliver. This turn died before any
    // assistant message existed, so the failing PROMPT's id is the only
    // identity there is, and it must be on the wire.
    expect(body.turn_message_id).toBe(PROMPT_MESSAGE)
  }, 30_000)

  test('an idle end does NOT claim a trailing prompt that has not run', async () => {
    // Same root shape — a user message with nothing after it — but the end is
    // `idle`, which on this shape means a QUEUED follow-up, not a failure.
    // Attributing the end to it would close a turn that never ran.
    const { current, target } = await tempCatalog()
    process.env.KORTIX_LLM_CATALOG_FILE = current
    const restarts = { n: 0 }
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    await relayTurnEndToApi(ROOT_SESSION, 'idle', fakeOpencode(restarts), cfg)

    expect(relayed).toHaveLength(1)
    expect(relayed[0]!.status).toBe('idle')
    expect(relayed[0]!.turn_message_id).toBeUndefined()
  }, 30_000)

  test('an ordinary turn error still relays, and buys no restart', async () => {
    const { current, target } = await tempCatalog()
    process.env.KORTIX_LLM_CATALOG_FILE = current
    const restarts = { n: 0 }
    registerModelReconcile(
      { opencode: fakeOpencode(restarts), cfg },
      { catalogTargetFile: target, turnProbe: async () => false },
    )

    await handleSessionErrorEvent(
      ROOT_SESSION,
      { name: 'APIError', message: 'Insufficient credits', statusCode: 402 },
      fakeOpencode(restarts),
      cfg,
    )

    expect(events).toEqual(['relay:end:error'])
    expect(restarts.n).toBe(0)
    expect(relayed[0]!.error_status).toBe(402)
  }, 30_000)
})
