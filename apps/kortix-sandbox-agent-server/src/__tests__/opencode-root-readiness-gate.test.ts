import { describe, expect, test } from 'bun:test'

import { waitForFastOpencodeRootReadiness } from '../main'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('fast OpenCode root readiness gate', () => {
  test('waits for the supervisor first-ready signal before root resolution', async () => {
    const ready = deferred()
    const events: string[] = []
    let now = 1_000
    const deadlinePromise = waitForFastOpencodeRootReadiness(
      {
        fastPathEnabled: true,
        firstReadyResponse: ready.promise,
      },
      {
        now: () => now,
        waitForSignal: async (signal, timeoutMs) => {
          events.push(`gate:${timeoutMs}`)
          await signal
          now += 4_200
          events.push('ready')
        },
      },
    )

    await Promise.resolve()
    expect(events).toEqual(['gate:5000'])

    ready.resolve()
    expect(await deadlinePromise).toBe(15_800)
    expect(events).toEqual(['gate:5000', 'ready'])
  })

  test('explicit false does not wait for readiness and keeps the full deadline', async () => {
    const deadlineMs = await waitForFastOpencodeRootReadiness(
      {
        fastPathEnabled: false,
        firstReadyResponse: new Promise<void>(() => {}),
      },
      {
        now: () => 10_000,
        waitForSignal: async () => {
          throw new Error('legacy path must not wait for the fast readiness signal')
        },
      },
    )

    expect(deadlineMs).toBe(20_000)
  })

  test('gate timeout falls through and consumes the same 20-second deadline', async () => {
    let now = 50_000
    const calls: string[] = []
    const deadlineMs = await waitForFastOpencodeRootReadiness(
      {
        fastPathEnabled: true,
        firstReadyResponse: new Promise<void>(() => {}),
      },
      {
        now: () => now,
        waitForSignal: async (_signal, timeoutMs) => {
          calls.push(`gate:${timeoutMs}`)
          now += timeoutMs
        },
      },
    )

    expect(deadlineMs).toBe(15_000)
    expect(calls).toEqual(['gate:5000'])
  })

  test('boot keeps subscribe-before-root ordering and uses only the existing fast flag', async () => {
    const src = await Bun.file(new URL('../main.ts', import.meta.url).pathname).text()
    const runtimeStart = src.indexOf('async function startSessionRuntime(')
    const runtimeEnd = src.indexOf('\n// Establish the session', runtimeStart)
    const runtime = src.slice(runtimeStart, runtimeEnd)
    const eventLoopAt = runtime.indexOf('startOpencodeEventLoop(opencode, cfg, eventHandlers)')
    const initialSessionAt = runtime.indexOf('await maybeCreateInitialOpencodeSession(', eventLoopAt)

    expect(eventLoopAt).toBeGreaterThan(-1)
    expect(initialSessionAt).toBeGreaterThan(eventLoopAt)
    expect(runtime.slice(eventLoopAt, initialSessionAt)).not.toContain('await startOpencodeEventLoop')

    const initialStart = src.indexOf('async function maybeCreateInitialOpencodeSession(')
    const initialEnd = src.indexOf('\nasync function resolveExistingRoot', initialStart)
    const initial = src.slice(initialStart, initialEnd)
    const gateAt = initial.indexOf('await waitForFastOpencodeRootReadiness(')
    const baseUrlAt = initial.indexOf('const baseUrl = opencode.getInternalUrl()')
    const rootAt = initial.indexOf('await resolveExistingRoot(', gateAt)
    const answeringAt = initial.indexOf("bootMark('opencode-answering')", rootAt)

    expect(gateAt).toBeGreaterThan(-1)
    expect(baseUrlAt).toBeGreaterThan(gateAt)
    expect(rootAt).toBeGreaterThan(gateAt)
    expect(answeringAt).toBeGreaterThan(rootAt)
    expect(initial).toContain(
      "const fastRootReadinessEnabled = process.env.KORTIX_OPENCODE_BINARY_PREFETCH === '1'",
    )
    expect(initial).toContain('fastPathEnabled: fastRootReadinessEnabled')
    expect(initial).toContain('onListening,\n    fastRootReadinessEnabled,')
  })

  test('initial prompt delivery never waits for the event stream handshake', async () => {
    const src = await Bun.file(new URL('../main.ts', import.meta.url).pathname).text()
    const initialStart = src.indexOf('async function maybeCreateInitialOpencodeSession(')
    const initialEnd = src.indexOf('\nasync function resolveExistingRoot', initialStart)
    const initial = src.slice(initialStart, initialEnd)

    expect(initial).not.toContain('eventLoopConnected')
    expect(initial).not.toContain('timer = setTimeout(r, 10_000)')
    expect(initial).not.toContain("bootMark('event-loop-connected')")
  })
})
