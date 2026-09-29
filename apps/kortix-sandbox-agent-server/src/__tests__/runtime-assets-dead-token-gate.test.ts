// KRTX-636: the runtime-truth ticker reconciles runtime assets every 60 s, and
// that is a `GET /v1/runtime-assets/manifest` carrying the box's KORTIX_TOKEN.
// A box whose session row is parked while its VM stays up is refused with
// `401 Session token is not active` on every fetch, and the API logs one `warn`
// line per fetch — the prod warn spike this guards, visible as a ~6 lines/min
// burst for as long as the box lives. `session-token-health.ts` already
// recognises the dead-token streak; the reconcile pass must consume it and stop
// asking with a credential the API has refused. It must NOT stop the process
// (see that module's header): it only skips the request that cannot succeed,
// and resumes the moment the control plane answers anything else.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { resolveHarness } from '@/harness/harness'
import {
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  noteControlPlaneResponse,
  resetSessionTokenHealthForTests,
  sessionTokenPresumedDead,
} from '@/lib/kortix-api/session-token-health'
import {
  reconcileRuntimeAssets,
  registerHarnessAssets,
  resetHarnessAssetsForTests,
} from '@/services/runtime-assets/runtime-assets'

// Production registers this lookup in main.ts before anything runs.
beforeAll(() => registerHarnessAssets((cfg) => resolveHarness(cfg).assets))
afterAll(() => resetHarnessAssetsForTests())

const API_URL = 'https://api.example.test'
const MANIFEST_URL = `${API_URL}/v1/runtime-assets/manifest`

function countingFetch() {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input))
    // A NON-dead 401 body: it must not trip the breaker on the healthy half.
    return new Response('nope', { status: 401 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

function tripDeadTokenBreaker() {
  for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
    noteControlPlaneResponse(401, 'Session token is not active')
  }
}

// Module-level state shared by every test file in this bun process — reset on
// the way in and the way out (test-state-reset-tripwire.test.ts).
beforeEach(() => resetSessionTokenHealthForTests())
afterEach(() => resetSessionTokenHealthForTests())

describe('reconcileRuntimeAssets — dead control-plane credential', () => {
  test('fetches the manifest while the credential works', async () => {
    const stub = countingFetch()
    await reconcileRuntimeAssets({ apiUrl: API_URL, token: 'kortix_pat_test', fetchImpl: stub.impl })
    expect(stub.calls).toEqual([MANIFEST_URL])
  })

  test('does not fetch once the API has affirmed the credential is dead', async () => {
    tripDeadTokenBreaker()
    const stub = countingFetch()
    const result = await reconcileRuntimeAssets({
      apiUrl: API_URL,
      token: 'kortix_pat_test',
      fetchImpl: stub.impl,
    })
    expect(stub.calls).toEqual([])
    expect(result).toEqual({
      cli: 'skipped',
      skills: 'skipped',
      reason: 'session credential refused by the control plane',
    })
  })

  test('resumes once the control plane answers anything else — a dead token is never terminal', async () => {
    tripDeadTokenBreaker()
    noteControlPlaneResponse(200, null)
    const stub = countingFetch()
    await reconcileRuntimeAssets({ apiUrl: API_URL, token: 'kortix_pat_test', fetchImpl: stub.impl })
    expect(stub.calls).toEqual([MANIFEST_URL])
  })

  // KRTX-613 reconciliation: the tripped gate must not be a life sentence.
  // While the credential stays dead the pass probes once per cooldown window
  // (the API logs one `warn` 401 per probe — bounded, not one per 60 s tick),
  // and a probe is the only tick-driven request that can notice a rotated or
  // repaired credential and clear the shared breaker again.
  test('while the credential stays dead, the pass probes at most once per cooldown', async () => {
    tripDeadTokenBreaker()
    const calls: string[] = []
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response('Session token is not active', { status: 401 })
    }) as unknown as typeof fetch
    const base = { apiUrl: API_URL, token: 'kortix_pat_test', fetchImpl: impl }

    // Cooldown wide enough that a back-to-back call stays inside it; the first
    // probe is forced due with `0` so the test does not depend on when the
    // previous test's fetch stamped the window.
    const cooldown = 50
    await reconcileRuntimeAssets({ ...base, probeCooldownMs: 0 }) // the probe
    await reconcileRuntimeAssets({ ...base, probeCooldownMs: cooldown }) // inside the window → skipped
    expect(calls).toEqual([MANIFEST_URL])
    expect(sessionTokenPresumedDead()).toBe(true) // the probe's dead answer keeps it tripped

    await Bun.sleep(cooldown + 10)
    await reconcileRuntimeAssets({ ...base, probeCooldownMs: cooldown }) // window elapsed → probe again
    expect(calls).toEqual([MANIFEST_URL, MANIFEST_URL])
    expect(sessionTokenPresumedDead()).toBe(true)
  })
})
