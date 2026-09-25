/**
 * Regression: a memory-guard abort must reach the control plane as the end of
 * THE turn it stopped.
 *
 * Observed 2026-09-18: the guard aborted two turns at 97 %
 * and 96 % box memory. The `SandboxMemoryGuard` end frame it relayed carried no
 * `turn_message_id`. The API only matches an id-less end against an active turn
 * that ALSO has no `messageId` (`fallback_match` in `completeSandboxTurn`), and
 * every real turn has one — so the frame settled as `identity_mismatch`, the
 * relay was skipped, and the reason never left the daemon. The user saw an
 * "Aborted" turn with no explanation.
 *
 * A second drop hid behind the first: the frame also said `error_retryable:
 * true`, which apps/api treats as non-terminal, so even a named frame was
 * ignored and only OpenCode's own "Aborted" end closed the turn.
 *
 * This drives the real wiring — `startOpenCodeBackground` → memory guard →
 * abort → relay — against a stubbed OpenCode and a stubbed API, with box memory
 * pinned at 97 %.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

import * as realTurnState from '../harness/open-code/opencode-turn-state'
import * as realResources from '../resources'

const ROOT = 'ses_root'

// Local machines (macOS) have no /proc/meminfo, so the real snapshot reports no
// memory figure and the guard can never fire. Inject a 97 % snapshot only while
// this file arms it; every other file keeps the real monitor untouched.
let injectPressure = false
// Copied BEFORE mock.module registers: the namespace object resolves to the mock
// once it exists, so reading it inside the factory would recurse into itself.
const real = { ...realResources }
mock.module('../resources', () => ({
  ...real,
  startResourceMonitor: (opts: Parameters<typeof real.startResourceMonitor>[0]) =>
    real.startResourceMonitor(
      injectPressure
        ? {
            ...opts,
            snapshot: async () => ({
              at: new Date().toISOString(),
              uptimeS: 662,
              load: [2.17, 1.42, 0.74],
              cpus: 2,
              memory: { totalMb: 3915, availableMb: 128, usedPct: 97, swapTotalMb: 0, swapFreeMb: 0 },
              cgroup: { currentMb: null, workingSetMb: null, maxMb: null, usedPct: null, oomKills: null },
              disks: [],
              daemon: { pid: 451, rssMb: 180, threads: 10, state: 'S' },
              runtime: { pid: 166, rssMb: 513, threads: 8, state: 'R' },
              runtimePids: [166],
            }),
          }
        : opts,
    ),
}))

// The pin file path is frozen when runtime-state.ts is first imported, and
// `bun test` shares one process across files — so the pinned root is injected
// the same flag-gated way instead of through a file.
const realTurn = { ...realTurnState }
mock.module('../harness/open-code/opencode-turn-state', () => ({
  ...realTurn,
  readPinnedSessionId: () => (injectPressure ? ROOT : realTurn.readPinnedSessionId()),
  opencodeTurnInFlight: (baseUrl: string, workspace: string, root?: string | null) =>
    realTurn.opencodeTurnInFlight(
      baseUrl,
      workspace,
      root === undefined ? (injectPressure ? ROOT : realTurn.readPinnedSessionId()) : root,
    ),
}))

const ENV_KEYS = [
  'KORTIX_MEMORY_GUARD_PCT',
  'KORTIX_ATTACHMENT_OFFLOAD',
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
] as const
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))

const OPENCODE_URL = 'http://127.0.0.1:4096'
const API_ROOT = 'http://api.test/v1'
const USER_MESSAGE_ID = 'msg_0000000d0001TestUserPrompt'

const ORIGINAL_FETCH = globalThis.fetch
let aborts: string[] = []
let turnStreamBodies: Array<Record<string, unknown>> = []
let stopMonitor: (() => void) | null = null

function stubOpenCodeAndApi(opts: { turnRunning: boolean }): void {
  aborts = []
  turnStreamBodies = []
  ;(globalThis as { fetch: unknown }).fetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const path = url.split('?')[0] ?? ''
    if (url.startsWith(API_ROOT)) {
      if (path.endsWith('/turn-stream')) turnStreamBodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (path.endsWith('/abort')) {
      aborts.push(path)
      return new Response('true', { status: 200 })
    }
    if (path.endsWith('/session/status')) {
      return new Response(JSON.stringify(opts.turnRunning ? { [ROOT]: { type: 'busy' } } : {}), { status: 200 })
    }
    if (path.endsWith(`/session/${ROOT}/message`)) {
      // The newest turn: its user prompt, and an assistant reply that is still
      // open while the turn runs.
      return new Response(
        JSON.stringify([
          { info: { id: USER_MESSAGE_ID, role: 'user', time: { created: 1 } }, parts: [] },
          {
            info: {
              id: 'msg_assistant',
              role: 'assistant',
              parentID: USER_MESSAGE_ID,
              time: opts.turnRunning ? { created: 2 } : { created: 2, completed: 3 },
            },
            parts: [],
          },
        ]),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
}

let startOpenCodeBackground: typeof import('../harness/open-code/background').startOpenCodeBackground

beforeAll(async () => {
  ;({ startOpenCodeBackground } = await import('../harness/open-code/background'))
})

afterEach(() => {
  stopMonitor?.()
  stopMonitor = null
  injectPressure = false
  ;(globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Boot the real background service at 97 % box memory and wait for its relay. */
async function runGuardAtPressure(opts: { turnRunning: boolean }): Promise<void> {
  process.env.KORTIX_MEMORY_GUARD_PCT = '92'
  process.env.KORTIX_ATTACHMENT_OFFLOAD = '0'
  process.env.KORTIX_PROJECT_ID = 'proj-1'
  process.env.KORTIX_SESSION_ID = 'sess-1'
  process.env.KORTIX_TOKEN = 'test-token'
  process.env.KORTIX_API_URL = 'http://api.test'
  stubOpenCodeAndApi(opts)
  injectPressure = true

  const monitor = startOpenCodeBackground(
    {
      getInternalUrl: () => OPENCODE_URL,
      getPid: () => 166,
      getState: () => 'ok',
    } as unknown as Parameters<typeof startOpenCodeBackground>[0],
    { workspace: '/workspace' } as Parameters<typeof startOpenCodeBackground>[1],
    { observe: async () => {}, stop: () => {} },
  )
  stopMonitor = monitor.stop

  await waitFor(() => turnStreamBodies.length > 0)
}

describe('memory guard turn end', () => {
  test('the relayed end names the turn it aborted, so the API can settle it', async () => {
    await runGuardAtPressure({ turnRunning: true })

    // Precondition: the guard did stop the running turn.
    expect(aborts).toEqual([`${OPENCODE_URL}/session/${ROOT}/abort`])
    // The relay is an error end for the box's own session…
    expect(turnStreamBodies).toHaveLength(1)
    const end = turnStreamBodies[0]!
    expect(end).toMatchObject({
      session_id: 'sess-1',
      kind: 'end',
      status: 'error',
      opencode_session_id: ROOT,
      error_name: 'SandboxMemoryGuard',
    })
    expect(String(end.error_message)).toContain('sandbox memory at 97%')
    // …and it must carry the aborted turn's identity. Without it the API's
    // `completeSandboxTurn` reports `identity_mismatch` for any turn that has a
    // `messageId` — all of them — and drops the reason.
    expect(end.turn_message_id).toBe(USER_MESSAGE_ID)
    // An aborted turn is over. apps/api reads `error_retryable: true` as "a
    // retry, still running" (`isTerminalTurnEnd`) and drops the frame as
    // `non_terminal` before it ever looks at the identity — verified on a real
    // sandbox 2026-09-21.
    expect(end.error_retryable).toBe(false)
  })

  test('with no turn in flight the relay stays unnamed, so it can never close a later turn', async () => {
    await runGuardAtPressure({ turnRunning: false })

    expect(aborts).toEqual([])
    expect(turnStreamBodies).toHaveLength(1)
    expect(turnStreamBodies[0]).toMatchObject({ kind: 'end', status: 'error', error_name: 'SandboxMemoryGuard' })
    expect(turnStreamBodies[0]).not.toHaveProperty('turn_message_id')
  })
})
