import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { Config } from '../config'
import * as git from '../git'
import type { Opencode } from '../opencode'
import { createRefreshRouter } from '../routes/refresh'
import * as runtimeAssets from '../runtime-assets'

const calls: unknown[] = []
let refreshDelay: Promise<void> | undefined
let refreshStarted: (() => void) | undefined
let refreshError: Error | undefined
const restoreSpies: Array<() => void> = []
const cfg = { sandboxToken: 'test-secret' } as Config
const opencode = { getState: () => 'ok', getPid: () => 123 } as Opencode
beforeEach(() => {
  calls.length = 0
  refreshDelay = undefined
  refreshStarted = undefined
  refreshError = undefined
  // Module replacements leak into the real Git and runtime-convergence tests
  // in the package's shared Bun process. Restore only these per-test spies.
  const refresh = spyOn(git, 'refreshRepo').mockImplementation(async () => {
    refreshStarted?.()
    await refreshDelay
    if (refreshError) throw refreshError
    const repo = { path: '/workspace', branch: 'main', commit: 'a', remoteUrl: null }
    return { before: repo, after: repo }
  })
  restoreSpies.push(() => refresh.mockRestore())
  const reconcile = spyOn(runtimeAssets, 'scheduleRuntimeAssetsReconcile').mockImplementation(
    (_cfg, options) => {
      calls.push(options)
    },
  )
  restoreSpies.push(() => reconcile.mockRestore())
})
afterEach(() => {
  for (const restore of restoreSpies.splice(0)) restore()
})

test('authenticated swap=1 carries the early idle-swap request into convergence', async () => {
  const response = await createRefreshRouter(cfg, opencode).request(
    'http://daemon/?restart=0&swap=1',
    { method: 'POST', headers: { Authorization: 'Bearer test-secret' } },
  )
  expect(response.status).toBe(200)
  expect(calls).toEqual([{ swap: true }])
})

test('swap=1 joins an in-flight refresh without losing the swap request', async () => {
  let release!: () => void
  refreshDelay = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve
  })
  const router = createRefreshRouter(cfg, opencode)
  const init = { method: 'POST', headers: { Authorization: 'Bearer test-secret' } }
  const first = router.request('http://daemon/?restart=0', init)
  await started
  expect((await router.request('http://daemon/?restart=0&swap=1', init)).status).toBe(409)
  release()
  expect((await first).status).toBe(200)
  expect(calls).toEqual([{ swap: true }])
})

test('a direct swap request survives a non-fast-forward repository refresh', async () => {
  refreshError = new Error('git pull refresh failed: Not possible to fast-forward, aborting.')
  const router = createRefreshRouter(cfg, opencode)
  const init = { method: 'POST', headers: { Authorization: 'Bearer test-secret' } }
  const response = await router.request('http://daemon/?restart=0&swap=1', init)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: 'refresh failed',
    message: refreshError.message,
  })
  expect(calls).toEqual([{ swap: true }])

  refreshError = undefined
  expect((await router.request('http://daemon/?restart=0', init)).status).toBe(200)
  expect(calls).toEqual([{ swap: true }, { swap: false }])
})

test('a coalesced swap request survives the in-flight repository refresh failing', async () => {
  refreshError = new Error('git pull refresh failed: Not possible to fast-forward, aborting.')
  let release!: () => void
  refreshDelay = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve
  })
  const router = createRefreshRouter(cfg, opencode)
  const init = { method: 'POST', headers: { Authorization: 'Bearer test-secret' } }
  const first = router.request('http://daemon/?restart=0', init)
  await started
  expect((await router.request('http://daemon/?restart=0&swap=1', init)).status).toBe(409)
  release()
  expect((await first).status).toBe(409)
  expect(calls).toEqual([{ swap: true }])
})

test('a failed explicit refresh still respects runtime readiness', async () => {
  refreshError = new Error('git pull refresh failed: Not possible to fast-forward, aborting.')
  const starting = { ...opencode, getState: () => 'starting' } as Opencode
  const response = await createRefreshRouter(cfg, starting).request(
    'http://daemon/?restart=0&swap=1',
    { method: 'POST', headers: { Authorization: 'Bearer test-secret' } },
  )
  expect(response.status).toBe(409)
  expect(calls).toEqual([])
})

test('a failed refresh without an explicit swap keeps the existing behavior', async () => {
  refreshError = new Error('git pull refresh failed: Not possible to fast-forward, aborting.')
  const response = await createRefreshRouter(cfg, opencode).request(
    'http://daemon/?restart=0',
    { method: 'POST', headers: { Authorization: 'Bearer test-secret' } },
  )
  expect(response.status).toBe(409)
  expect(calls).toEqual([])
})

test('unauthenticated swap=1 cannot schedule convergence', async () => {
  const response = await createRefreshRouter(cfg, opencode).request(
    'http://daemon/?restart=0&swap=1',
    { method: 'POST' },
  )
  expect(response.status).toBe(401)
  expect(calls).toEqual([])
})

test('swap=1 does not converge a booting runtime', async () => {
  const starting = { ...opencode, getState: () => 'starting' } as Opencode
  const response = await createRefreshRouter(cfg, starting).request(
    'http://daemon/?restart=0&swap=1',
    { method: 'POST', headers: { Authorization: 'Bearer test-secret' } },
  )
  expect(response.status).toBe(200)
  expect(calls).toEqual([])
})
