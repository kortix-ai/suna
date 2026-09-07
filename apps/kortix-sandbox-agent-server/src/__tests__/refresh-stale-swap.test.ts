import { beforeEach, expect, mock, test } from 'bun:test'
import type { Config } from '../config'
import type { Opencode } from '../opencode'

const calls: unknown[] = []
let refreshDelay: Promise<void> | undefined
let refreshStarted: (() => void) | undefined
mock.module('../git', () => ({
  refreshRepo: async () => {
    refreshStarted?.()
    await refreshDelay
    return { before: 'a', after: 'a' }
  },
  syncOpencodeConfigDirToBase: async () => ({}),
  syncWorkspaceToBase: async () => ({ before: 'a', after: 'a' }),
}))
mock.module('../runtime-assets', () => ({
  scheduleRuntimeAssetsReconcile: (_cfg: Config, options: unknown) => {
    calls.push(options)
  },
}))
const { createRefreshRouter } = await import('../routes/refresh')
const cfg = { sandboxToken: 'test-secret' } as Config
const opencode = { getState: () => 'ok', getPid: () => 123 } as Opencode
beforeEach(() => {
  calls.length = 0
  refreshDelay = undefined
  refreshStarted = undefined
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
