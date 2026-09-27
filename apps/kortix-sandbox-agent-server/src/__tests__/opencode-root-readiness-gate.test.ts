import { describe, expect, test } from 'bun:test'

import { waitForOpencodeRootReadiness } from '../harness/open-code/boot'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('OpenCode root readiness gate', () => {
  test('every boot waits for the listening announcement before the first root-list request', async () => {
    // A root-list request sent before OpenCode's request handler exists is
    // never answered and burns the whole 5 s attempt timeout (the S3-boot
    // penalty measured 2026-09-15). The gate holds the request for the
    // lifecycle's listening signal and hands the remaining budget on.
    const listening = deferred()
    const events: string[] = []
    let now = 1_000
    const deadlinePromise = waitForOpencodeRootReadiness(
      { firstListening: listening.promise },
      {
        now: () => now,
        waitForSignal: async (signal, timeoutMs) => {
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

  test('gate timeout falls through and consumes the same 20-second deadline', async () => {
    let now = 5_000
    const calls: string[] = []
    const deadlineMs = await waitForOpencodeRootReadiness(
      { firstListening: new Promise<void>(() => {}) },
      {
        now: () => now,
        waitForSignal: async (_signal, timeoutMs) => {
          calls.push(`gate:${timeoutMs}`)
          now += timeoutMs
        },
      },
    )

    // The gate spent its whole 5 s budget; the resolver keeps the remaining 15 s.
    expect(deadlineMs).toBe(15_000)
    expect(calls).toEqual(['gate:5000'])
  })
})
