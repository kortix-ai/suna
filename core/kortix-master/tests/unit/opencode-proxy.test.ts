import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { proxyToOpenCode } from '../../src/services/proxy'
import { serviceManager } from '../../src/services/service-manager'

describe('proxyToOpenCode', () => {
  let app: Hono
  const originalFetch = globalThis.fetch
  const originalRecovery = serviceManager.requestRecovery.bind(serviceManager)

  beforeEach(() => {
    app = new Hono()
    app.all('*', proxyToOpenCode)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    serviceManager.requestRecovery = originalRecovery
  })

  it('does not forward Accept-Encoding to OpenCode', async () => {
    let forwardedHeaders = new Headers()

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwardedHeaders = new Headers(init?.headers)
      return new Response('{"healthy":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const res = await app.request('http://localhost/global/health', {
      headers: {
        'Accept-Encoding': 'gzip, deflate, br',
        'X-Custom-Header': 'keep-me',
      },
    })

    expect(res.status).toBe(200)
    expect(forwardedHeaders.get('accept-encoding')).toBeNull()
    expect(forwardedHeaders.get('x-custom-header')).toBe('keep-me')
  })

  it('strips encoded and hop-by-hop headers when rebuilding OpenCode responses', async () => {
    globalThis.fetch = (async () => {
      return new Response('{"healthy":true}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': '999',
          'transfer-encoding': 'chunked',
          'connection': 'keep-alive',
          'x-opencode-header': 'preserved',
        },
      })
    }) as typeof fetch

    const res = await app.request('http://localhost/global/health')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(res.headers.get('connection')).toBeNull()
    expect(res.headers.get('x-opencode-header')).toBe('preserved')
    expect(await res.text()).toBe('{"healthy":true}')
  })

  it('does not trigger recovery when a request times out but OpenCode health is still OK', async () => {
    let recoveryCalls = 0

    serviceManager.requestRecovery = (async () => {
      recoveryCalls += 1
      return { ok: true, output: 'recovered' }
    }) as typeof serviceManager.requestRecovery

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new DOMException('timed out', 'TimeoutError')
    }) as typeof fetch

    const res = await app.request('http://localhost/file/status')

    expect(res.status).toBe(504)
    expect(recoveryCalls).toBe(0)
  })

  it('triggers recovery when a non-file-status request times out and OpenCode health check also fails', async () => {
    let recoveryCalls = 0

    serviceManager.requestRecovery = (async () => {
      recoveryCalls += 1
      return { ok: true, output: 'recovered' }
    }) as typeof serviceManager.requestRecovery

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) {
        throw new Error('ECONNREFUSED')
      }
      throw new DOMException('timed out', 'TimeoutError')
    }) as typeof fetch

    const res = await app.request('http://localhost/global/health')

    expect(res.status).toBe(504)
    expect(recoveryCalls).toBe(1)
  })

  it('does not trigger recovery for /file/status timeouts even when health check fails', async () => {
    let recoveryCalls = 0

    serviceManager.requestRecovery = (async () => {
      recoveryCalls += 1
      return { ok: true, output: 'recovered' }
    }) as typeof serviceManager.requestRecovery

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/session')) {
        throw new Error('ECONNREFUSED')
      }
      throw new DOMException('timed out', 'TimeoutError')
    }) as typeof fetch

    const res = await app.request('http://localhost/file/status')

    expect(res.status).toBe(504)
    expect(recoveryCalls).toBe(0)
  })
})
