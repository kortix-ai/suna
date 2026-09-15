import { describe, expect, test } from 'bun:test'

import { waitForFastOpencodeRootReadiness } from '../main'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const never = new Promise<void>(() => {})

describe('OpenCode root readiness gate', () => {
  test('every boot waits for the listening announcement before the first root-list request', async () => {
    // A root-list request sent before OpenCode's request handler exists is
    // never answered and burns the whole 5 s attempt timeout (the S3-boot
    // penalty measured 2026-09-15). The gate holds the request for the
    // supervisor's listening signal, on the legacy path too.
    const listening = deferred()
    const events: string[] = []
    let now = 1_000
    const deadlinePromise = waitForFastOpencodeRootReadiness(
      {
        fastPathEnabled: false,
        firstListening: listening.promise,
        firstReadyResponse: never,
      },
      {
        now: () => now,
        waitForSignal: async (signal, timeoutMs) => {
          if (signal === never) throw new Error('legacy path must not wait for the ready signal')
          events.push(`listening-gate:${timeoutMs}`)
          await signal
          now += 700
          events.push('listening')
        },
      },
    )

    await Promise.resolve()
    expect(events).toEqual(['listening-gate:5000'])

    listening.resolve()
    expect(await deadlinePromise).toBe(19_300)
    expect(events).toEqual(['listening-gate:5000', 'listening'])
  })

  test('fast path waits for the listening announcement, then for the first ready answer', async () => {
    const listening = deferred()
    const ready = deferred()
    const events: string[] = []
    let now = 1_000
    const deadlinePromise = waitForFastOpencodeRootReadiness(
      {
        fastPathEnabled: true,
        firstListening: listening.promise,
        firstReadyResponse: ready.promise,
      },
      {
        now: () => now,
        waitForSignal: async (signal, timeoutMs) => {
          const name = signal === listening.promise ? 'listening' : 'ready'
          events.push(`${name}-gate:${timeoutMs}`)
          await signal
          now += name === 'listening' ? 800 : 3_400
          events.push(name)
        },
      },
    )

    await Promise.resolve()
    expect(events).toEqual(['listening-gate:5000'])

    listening.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // The ready wait only gets what is left of the same 5 s gate budget.
    expect(events).toEqual(['listening-gate:5000', 'listening', 'ready-gate:4200'])

    ready.resolve()
    expect(await deadlinePromise).toBe(15_800)
    expect(events).toEqual(['listening-gate:5000', 'listening', 'ready-gate:4200', 'ready'])
  })

  test('gate timeout falls through and consumes the same 20-second deadline', async () => {
    let now = 50_000
    const calls: string[] = []
    const deadlineMs = await waitForFastOpencodeRootReadiness(
      {
        fastPathEnabled: true,
        firstListening: never,
        firstReadyResponse: never,
      },
      {
        now: () => now,
        waitForSignal: async (_signal, timeoutMs) => {
          calls.push(`gate:${timeoutMs}`)
          now += timeoutMs
        },
      },
    )

    // The listening gate spent the whole budget; the ready gate gets 0 and
    // returns at once. The resolver keeps the remaining 15 s.
    expect(deadlineMs).toBe(15_000)
    expect(calls).toEqual(['gate:5000', 'gate:0'])
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
    expect(initial).toContain('firstListening: opencode.waitForCurrentListening()')
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
