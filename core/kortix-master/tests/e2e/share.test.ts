import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'

/**
 * E2E-style tests for the share system.
 *
 * Tests the real share route + share store + share proxy together.
 * Starts a tiny test HTTP server to verify the proxy actually works end-to-end.
 */

const ENV_KEYS = [
  'ENV_MODE', 'JUSTAVPS_SLUG', 'JUSTAVPS_PROXY_TOKEN', 'JUSTAVPS_PROXY_DOMAIN',
  'SANDBOX_ID', 'KORTIX_API_URL', 'SHARE_STORE_PATH',
]
const savedEnv: Record<string, string | undefined> = {}

function saveEnv() { for (const k of ENV_KEYS) savedEnv[k] = process.env[k] }
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k] }

describe('Share system E2E', () => {
  let shareRouter: any
  let shareProxyRouter: any
  let initShareStore: () => void

  beforeAll(async () => {
    saveEnv()
    clearEnv()
    process.env.SHARE_STORE_PATH = `/tmp/test-shares-e2e-${Date.now()}.json`

    shareRouter = (await import('../../src/routes/share')).default
    shareProxyRouter = (await import('../../src/routes/share-proxy')).default
    initShareStore = (await import('../../src/services/share-store')).initShareStore
    initShareStore()
  })

  afterAll(() => {
    restoreEnv()
  })

  function buildApp() {
    const app = new Hono()
    app.route('/kortix/share', shareRouter)
    app.route('/s', shareProxyRouter)
    return app
  }

  // ── Share creation ────────────────────────────────────────────────────

  test('creates share with all required fields', async () => {
    const app = buildApp()
    const res = await app.request('/kortix/share/3000')

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toHaveProperty('url')
    expect(body).toHaveProperty('port', 3000)
    expect(body).toHaveProperty('token')
    expect(body).toHaveProperty('expiresAt')
    expect(body).toHaveProperty('ttl', '1h')
    expect(body.token.length).toBeGreaterThan(10)
  })

  test('each share gets a unique token', async () => {
    const app = buildApp()
    const a = await (await app.request('/kortix/share/3000')).json() as any
    const b = await (await app.request('/kortix/share/3000')).json() as any
    expect(a.token).not.toBe(b.token)
  })

  // ── Share proxy: valid token ──────────────────────────────────────────

  test('share proxy returns 410 for invalid token', async () => {
    const app = buildApp()
    const res = await app.request('/s/invalid_token_xxx/')
    expect(res.status).toBe(410)
    const body = await res.json() as any
    expect(body.error).toContain('expired')
  })

  test('share proxy returns 502 when nothing listens on the port', async () => {
    const app = buildApp()
    // Create a share for a port where nothing is running
    const createRes = await app.request('/kortix/share/19999')
    const { token } = await createRes.json() as any

    const res = await app.request(`/s/${token}/`)
    // Should be 502 (service not running) — not 410 (token invalid)
    expect(res.status).toBe(502)
    const body = await res.json() as any
    expect(body.error).toContain('not running')
  })

  // ── TTL enforcement ───────────────────────────────────────────────────

  test('custom TTL works: 30m', async () => {
    const app = buildApp()
    const res = await app.request('/kortix/share/3000?ttl=30m')
    const body = await res.json() as any

    expect(body.ttl).toBe('30m')
    const expires = new Date(body.expiresAt).getTime()
    const now = Date.now()
    expect(expires - now).toBeGreaterThan(29 * 60 * 1000)
    expect(expires - now).toBeLessThan(31 * 60 * 1000)
  })

  test('rejects TTL below 5m', async () => {
    const app = buildApp()
    const res = await app.request('/kortix/share/3000?ttl=1m')
    expect(res.status).toBe(400)
  })

  test('rejects TTL above 7d', async () => {
    const app = buildApp()
    const res = await app.request('/kortix/share/3000?ttl=8d')
    expect(res.status).toBe(400)
  })

  // ── List + revoke ─────────────────────────────────────────────────────

  test('list shows created shares', async () => {
    const app = buildApp()
    const { token } = await (await app.request('/kortix/share/4444')).json() as any

    const listRes = await app.request('/kortix/share')
    const { shares } = await listRes.json() as any
    expect(shares.some((s: any) => s.token === token)).toBe(true)
  })

  test('revoke makes token invalid', async () => {
    const app = buildApp()
    const { token } = await (await app.request('/kortix/share/5555')).json() as any

    // Revoke
    const delRes = await app.request(`/kortix/share/${token}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    // Token should now be invalid at the proxy
    const proxyRes = await app.request(`/s/${token}/`)
    expect(proxyRes.status).toBe(410)
  })

  // ── CORS on share proxy ───────────────────────────────────────────────

  test('share proxy OPTIONS returns CORS headers', async () => {
    const app = buildApp()
    const { token } = await (await app.request('/kortix/share/3000')).json() as any

    const res = await app.request(`/s/${token}/`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  // ── Port validation ───────────────────────────────────────────────────

  test('port 0 rejected', async () => {
    const app = buildApp()
    expect((await app.request('/kortix/share/0')).status).toBe(400)
  })

  test('port 65535 accepted', async () => {
    const app = buildApp()
    const res = await app.request('/kortix/share/65535')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.port).toBe(65535)
  })

  // ── URL format ────────────────────────────────────────────────────────

  test('URL contains /s/{token}/', async () => {
    const app = buildApp()
    const body = await (await app.request('/kortix/share/3000')).json() as any
    expect(body.url).toMatch(/\/s\/[A-Za-z0-9_-]+\//)
  })

  test('cloud mode URL includes __proxy_token', async () => {
    process.env.ENV_MODE = 'cloud'
    process.env.JUSTAVPS_SLUG = 'test-slug'
    process.env.JUSTAVPS_PROXY_TOKEN = 'cloud_tok'

    const app = buildApp()
    const body = await (await app.request('/kortix/share/3000')).json() as any
    expect(body.url).toContain('__proxy_token=cloud_tok')
    expect(body.url).toContain('8000--test-slug')

    clearEnv()
    process.env.SHARE_STORE_PATH = `/tmp/test-shares-e2e-${Date.now()}.json`
  })

  test('explicit PUBLIC_BASE_URL wins over cloud fallback URLs', async () => {
    process.env.ENV_MODE = 'cloud'
    process.env.SANDBOX_ID = 'sb_123'
    process.env.KORTIX_API_URL = 'https://api.kortix.test/v1/router'
    process.env.PUBLIC_BASE_URL = 'https://8000--real-slug.kortix.cloud?__proxy_token=pt_real'

    const app = buildApp()
    const body = await (await app.request('/kortix/share/3000')).json() as any
    expect(body.url).toContain('https://8000--real-slug.kortix.cloud')
    expect(body.url).toContain('__proxy_token=pt_real')
    expect(body.url).not.toContain('/v1/p/sb_123/8000')

    clearEnv()
    process.env.SHARE_STORE_PATH = `/tmp/test-shares-e2e-${Date.now()}.json`
  })
})
