/**
 * `/kortix/config/converge`, `/kortix/config/workspace`, and the
 * `/kortix/refresh?config_dir=1` alias.
 *
 * The converge route is a trigger. It never reads the request body: the daemon
 * fetches the descriptor from the API, so a caller cannot choose the config.
 */
import { describe, expect, test } from 'bun:test'
import type { Config } from '@/lib/config/config'
import type { HarnessConfigConvergeResult, HarnessControlOperations } from '@/harness/contract/control'
import { ConvergeBusyError } from '@/services/config-provider/release'
import { MAX_SWAP_DELAY_MS } from '@/harness/contract/control'
import { createConfigRouter } from '@/routes/kortix/config'
import { createRefreshRouter } from '@/routes/kortix/refresh'

const TOKEN = 'sandbox-token'
const cfgWithToken = { sandboxToken: TOKEN } as Config
const bearer = { Authorization: `Bearer ${TOKEN}` }

const converged: HarnessConfigConvergeResult = {
  ok: true,
  outcome: 'unchanged',
  config: {
    release_id: 'a'.repeat(64),
    desired_release_id: 'a'.repeat(64),
    source: 'release',
    mode: 'follow-base',
    proven: true,
    fallback_reason: null,
    failed_release_id: null,
  },
  reload: null,
  reason: null,
}

function fakeControl(over: Partial<HarnessControlOperations> = {}) {
  const calls = { converge: [] as unknown[][], refresh: 0 }
  const control: HarnessControlOperations = {
    applyEnvironment: async () => {
      throw new Error('unexpected env')
    },
    refresh: async () => {
      calls.refresh++
      return { ok: true, repo: {} as never, runtime: 'ok', runtime_pid: 1 }
    },
    abort: async () => {
      throw new Error('unexpected abort')
    },
    armAbortAfterTool: async () => undefined,
    disarmAbortAfterTool: () => undefined,
    convergeConfig: async (...args: unknown[]) => {
      calls.converge.push(args)
      return converged
    },
    ...over,
  }
  return { control, calls }
}

describe('config routes with a fake control', () => {
  test('converge requires the sandbox bearer', async () => {
    const { control, calls } = fakeControl()
    const router = createConfigRouter(cfgWithToken, control)
    expect((await router.request('/converge', { method: 'POST' })).status).toBe(401)
    expect((await router.request('/converge', { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect(calls.converge).toHaveLength(0)
    const unconfigured = createConfigRouter({} as Config, control)
    expect((await unconfigured.request('/converge', { method: 'POST', headers: bearer })).status).toBe(503)
  })

  test('converge passes nothing from the request body to the control', async () => {
    const { control, calls } = fakeControl()
    const router = createConfigRouter(cfgWithToken, control)
    const res = await router.request('/converge', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'config-release-v2', release_id: 'e'.repeat(64), archive: { url: 'https://evil' } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(converged)
    // The only thing the route reads off the request is the fault-injection
    // delay, and it is absent here.
    expect(calls.converge).toEqual([[{ delayBeforeSwapMs: undefined }]])
  })

  /**
   * `?delay_before_swap_ms` — fault injection, the same shape as `verify_fail`
   * on `POST /kortix/refresh`. It holds a convergence between the turn gate and
   * the swap, so a test can land a prompt inside the window DEF-DEV-1 lived in
   * instead of racing it.
   */
  test('the fault-injection delay is read, bounded, and never negative', async () => {
    const cases: Array<[string, number | undefined]> = [
      ['250', 250],
      // Bounded: a caller cannot park a convergence for an hour.
      [String(MAX_SWAP_DELAY_MS * 10), MAX_SWAP_DELAY_MS],
      ['0', undefined],
      ['-5', undefined],
      ['nonsense', undefined],
    ];
    for (const [raw, expected] of cases) {
      const { control, calls } = fakeControl()
      const res = await createConfigRouter(cfgWithToken, control).request(
        `/converge?delay_before_swap_ms=${encodeURIComponent(raw)}`,
        { method: 'POST', headers: bearer },
      )
      expect(res.status).toBe(200)
      expect(calls.converge).toEqual([[{ delayBeforeSwapMs: expected }]])
    }
  })

  test('the refresh alias carries the delay too', async () => {
    const { control, calls } = fakeControl()
    const res = await createRefreshRouter(cfgWithToken, control).request(
      '/?config_dir=1&delay_before_swap_ms=300',
      { method: 'POST', headers: bearer },
    )
    expect(res.status).toBe(200)
    expect(calls.converge).toEqual([[{ delayBeforeSwapMs: 300 }]])
  })

  test('a convergence already running answers 409', async () => {
    const { control } = fakeControl({
      convergeConfig: async () => {
        throw new ConvergeBusyError()
      },
    })
    const res = await createConfigRouter(cfgWithToken, control).request('/converge', { method: 'POST', headers: bearer })
    expect(res.status).toBe(409)
  })

  test('the workspace-report route is gone: the descriptor request has no inputs', async () => {
    const { control } = fakeControl()
    const res = await createConfigRouter(cfgWithToken, control).request('/workspace', { headers: bearer })
    expect(res.status).toBe(404)
  })

  test('refresh?config_dir=1 is an alias of converge; the plain refresh does not run', async () => {
    const { control, calls } = fakeControl()
    const res = await createRefreshRouter(cfgWithToken, control).request(
      '/?config_dir=1&reload_if_synced=1&restart=0&repo=0',
      { method: 'POST', headers: bearer },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(converged)
    expect(calls.converge).toHaveLength(1)
    expect(calls.refresh).toBe(0)
  })

  test('a runtime without config releases: converge is 404, config_dir=1 keeps the plain refresh', async () => {
    const { control, calls } = fakeControl({ convergeConfig: undefined })
    expect(
      (await createConfigRouter(cfgWithToken, control).request('/converge', { method: 'POST', headers: bearer })).status,
    ).toBe(404)
    const res = await createRefreshRouter(cfgWithToken, control).request('/?config_dir=1', {
      method: 'POST',
      headers: bearer,
    })
    expect(res.status).toBe(200)
    expect(calls.refresh).toBe(1)
  })
})
