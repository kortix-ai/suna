import { describe, expect, test } from 'bun:test'
import type { Config } from '@/lib/config/config'
import type { ChromeBridge } from '@/services/chrome/chrome-bridge'
import { createChromeRouter } from './chrome'

// Strix review of v0.14.10: the preview proxy relays a collaborator's request with
// the box's own bearer, so only the signed user context marks it as relayed.
function router() {
  const calls: string[] = []
  const bridge = {
    attach: async () => { calls.push('attach'); return { status: 200, body: { attached: true } } },
    release: async () => { calls.push('release'); return { status: 204 } },
    status: () => { calls.push('status'); return { attached: false } },
  } as unknown as ChromeBridge
  return { app: createChromeRouter({ sandboxToken: 'box-token' } as Config, bridge), calls }
}
const bearer = { Authorization: 'Bearer box-token' }

describe('kortix chrome control routes', () => {
  test('the in-box CLI (box bearer, no user context) attaches, releases and reads status', async () => {
    const { app, calls } = router()
    expect((await app.request('/attach', { method: 'POST', headers: bearer, body: '{}' })).status).toBe(200)
    expect((await app.request('/release', { method: 'POST', headers: bearer })).status).toBe(204)
    expect((await app.request('/status', { headers: bearer })).status).toBe(200)
    expect(calls).toEqual(['attach', 'release', 'status'])
  })

  test('a relayed request never reaches the bridge, by header or by query', async () => {
    const { app, calls } = router()
    const relayed = { ...bearer, 'X-Kortix-User-Context': 'any.signature' }
    expect((await app.request('/attach', { method: 'POST', headers: relayed, body: '{}' })).status).toBe(404)
    expect((await app.request('/release', { method: 'POST', headers: relayed })).status).toBe(404)
    expect((await app.request('/status', { headers: relayed })).status).toBe(404)
    expect((await app.request('/attach?__kortix_user_context=x', { method: 'POST', headers: bearer, body: '{}' })).status).toBe(404)
    expect(calls).toEqual([])
  })

  test('no bearer and no user context is unauthorized', async () => {
    const { app, calls } = router()
    expect((await app.request('/attach', { method: 'POST', body: '{}' })).status).toBe(401)
    expect(calls).toEqual([])
  })
})
